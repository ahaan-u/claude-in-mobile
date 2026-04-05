import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WDAClient } from "./wda-client.js";
import { WDAInstanceInfo } from "./wda-types.js";

export class WDAManager {
  private instances: Map<string, WDAInstanceInfo> = new Map();
  private clients: Map<string, WDAClient> = new Map();
  /** Deduplicates parallel launches for the same device */
  private launchPromises: Map<string, Promise<WDAClient>> = new Map();
  private readonly startupTimeout = 30000;
  private readonly buildTimeout = 120000;

  async ensureWDAReady(deviceId: string): Promise<WDAClient> {
    // Check existing client
    if (this.clients.has(deviceId)) {
      const client = this.clients.get(deviceId)!;
      try {
        await client.ensureSession(deviceId);
        return client;
      } catch (error: any) {
        console.error("WDA client failed, relaunching:", error.message);
        // Clean up failed instance
        const instance = this.instances.get(deviceId);
        if (instance) {
          try {
            process.kill(instance.pid);
          } catch {}
        }
        this.clients.delete(deviceId);
        this.instances.delete(deviceId);
        // Fall through to relaunch
      }
    }

    // Deduplicate parallel launches — if another call is already launching
    // WDA for this device, reuse its promise instead of spawning a second xcodebuild
    if (this.launchPromises.has(deviceId)) {
      return this.launchPromises.get(deviceId)!;
    }

    const launchPromise = this.doLaunch(deviceId);
    this.launchPromises.set(deviceId, launchPromise);

    try {
      return await launchPromise;
    } finally {
      this.launchPromises.delete(deviceId);
    }
  }

  private async doLaunch(deviceId: string): Promise<WDAClient> {
    const wdaPath = await this.discoverWDA();
    await this.buildWDAIfNeeded(wdaPath);
    await this.launchWDA(wdaPath, deviceId);
    const port = await this.discoverWDAPort(deviceId);

    const client = new WDAClient(port);
    await client.ensureSession(deviceId);

    this.clients.set(deviceId, client);

    return client;
  }

  private async discoverWDA(): Promise<string> {
    const searchPaths = [
      process.env.WDA_PATH,
      path.join(
        os.homedir(),
        ".appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent"
      ),
      "/opt/homebrew/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent",
      "/usr/local/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent",
    ].filter(Boolean) as string[];

    for (const searchPath of searchPaths) {
      if (fs.existsSync(searchPath)) {
        const projectPath = path.join(searchPath, "WebDriverAgent.xcodeproj");
        if (fs.existsSync(projectPath)) {
          return searchPath;
        }
      }
    }

    throw new Error(
      "WebDriverAgent not found.\n\n" +
        "Install Appium with XCUITest driver:\n" +
        "  npm install -g appium\n" +
        "  appium driver install xcuitest\n\n" +
        "Or set WDA_PATH environment variable:\n" +
        "  export WDA_PATH=/path/to/WebDriverAgent\n\n" +
        "Search paths checked:\n" +
        searchPaths.map((p) => `  - ${p}`).join("\n")
    );
  }

  private async buildWDAIfNeeded(wdaPath: string): Promise<void> {
    const buildDir = path.join(wdaPath, "build");
    if (fs.existsSync(buildDir)) {
      return;
    }

    console.error("Building WebDriverAgent for first use...");

    try {
      execSync(
        "xcodebuild build-for-testing " +
          "-project WebDriverAgent.xcodeproj " +
          "-scheme WebDriverAgentRunner " +
          "-destination 'platform=iOS Simulator,name=iPhone 14'",
        {
          cwd: wdaPath,
          timeout: this.buildTimeout,
          stdio: "pipe",
        }
      );
    } catch (error: any) {
      throw new Error(
        "Failed to build WebDriverAgent.\n\n" +
          `${error.stderr?.toString() || error.stdout?.toString() || error.message}\n\n` +
          "Troubleshooting:\n" +
          "1. Install Xcode: https://apps.apple.com/app/xcode/id497799835\n" +
          "2. Install command line tools: xcode-select --install\n" +
          "3. Accept license: sudo xcodebuild -license accept\n" +
          "4. Set Xcode path: sudo xcode-select -s /Applications/Xcode.app"
      );
    }
  }

  /**
   * Launch xcodebuild to start WDA on the target simulator.
   *
   * We intentionally do NOT set USE_PORT or pre-allocate a port. WDA has
   * its own atomic port scanning (tries 8100, then 8101, etc. via bind()).
   * Pre-allocating with findFreePort() caused a TOCTOU race: multiple
   * parallel sessions could all find the same port "free", but only one
   * WDA would win the bind. The losers' health checks would then pass
   * against the winner's WDA — which is on a different simulator, causing
   * screenshot and get_ui/tap to target different devices (split-brain).
   *
   * Instead, we let WDA pick its own port atomically, then discover
   * which port it chose via discoverWDAPort().
   */
  private async launchWDA(
    wdaPath: string,
    deviceId: string,
  ): Promise<void> {
    const existingInstance = this.instances.get(deviceId);
    if (existingInstance) {
      try {
        process.kill(existingInstance.pid, 0);
        return;
      } catch {
        this.instances.delete(deviceId);
      }
    }

    const wdaProcess = spawn(
      "xcodebuild",
      [
        "test-without-building",
        "-project",
        "WebDriverAgent.xcodeproj",
        "-scheme",
        "WebDriverAgentRunner",
        "-destination",
        `platform=iOS Simulator,id=${deviceId}`,
      ],
      {
        cwd: wdaPath,
        stdio: "pipe",
      }
    );

    this.instances.set(deviceId, {
      pid: wdaProcess.pid!,
      port: 0, // unknown until discoverWDAPort() finds it
      deviceId,
    });

    wdaProcess.on("exit", (code) => {
      this.instances.delete(deviceId);
      this.clients.delete(deviceId);
    });
  }

  /**
   * Discover which port our WDA actually bound to by finding the
   * WebDriverAgentRunner process for our specific device UDID.
   *
   * Each simulator's WDA runner path contains the device UDID:
   *   /Users/.../CoreSimulator/Devices/<UDID>/data/.../WebDriverAgentRunner-Runner.app/...
   *
   * We find that process, then use lsof to read which port it's listening
   * on. This is the only reliable way to identify our WDA when multiple
   * simulators are running — the device UDID in the path is guaranteed
   * unique per simulator.
   *
   * Alternatives considered:
   * - findFreePort() + USE_PORT env var (original approach): USE_PORT
   *   itself works (verified — WDA binds the specified port). But
   *   findFreePort() has a TOCTOU race: it probes a port by binding and
   *   releasing, then passes it via USE_PORT. When multiple sessions race,
   *   they can all probe the same port as "free" before any WDA binds it.
   *   Only one WDA wins the bind; the others' health checks silently pass
   *   against the winner's WDA — which is on a different simulator. This
   *   causes screenshot (simctl, UDID-addressed) and get_ui/tap (WDA,
   *   port-addressed) to target different devices (split-brain).
   * - Parsing WDA's "ServerURLHere" log output: fragile, format changes
   *   between WDA versions.
   * - Comparing UI state (bundle ID, screenshots): fails when multiple
   *   sessions run the same app.
   */
  private async discoverWDAPort(deviceId: string): Promise<number> {
    const startTime = Date.now();
    while (Date.now() - startTime < this.startupTimeout) {
      try {
        // Find WDA runner process for our device by UDID in process path
        const psOutput = execSync(
          "ps -eo pid,command", { encoding: "utf-8", timeout: 5000 }
        );
        const lines = psOutput.split("\n");
        const wdaLine = lines.find(
          (l) => l.includes("WebDriverAgentRunner-Runner") &&
                 l.includes(deviceId)
        );
        if (wdaLine) {
          const pid = wdaLine.trim().split(/\s+/)[0];
          // Find which port this PID is listening on.
          // IMPORTANT: macOS lsof -p PID returns ALL listening processes
          // (not just the target PID) when the target has no matching TCP
          // entries yet. We must filter the output lines by PID to avoid
          // picking up another WDA's port — which is exactly the split-
          // brain bug we're fixing.
          const lsofOutput = execSync(
            `lsof -nP -p ${pid} -iTCP -sTCP:LISTEN`,
            { encoding: "utf-8", timeout: 5000 }
          );
          const lsofLines = lsofOutput.split("\n");
          const pidPattern = new RegExp(`\\b${pid}\\b`);
          const ourLine = lsofLines.find(
            (l) => pidPattern.test(l) && l.includes("LISTEN")
          );
          const portMatch = ourLine?.match(/:(\d+)\s+\(LISTEN\)/);
          if (portMatch) {
            const port = parseInt(portMatch[1]);
            // Port is bound, but WDA may not be ready to accept HTTP
            // requests yet (binding happens before the server loop starts)
            if (await this.checkHealth(port)) {
              const instance = this.instances.get(deviceId);
              if (instance) {
                instance.port = port;
              }
              return port;
            }
            // Port bound but not healthy yet — keep polling
          }
        }
      } catch {
        // Process not found yet or lsof failed — keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Clean up the xcodebuild process on timeout
    const instance = this.instances.get(deviceId);
    if (instance) {
      try {
        process.kill(instance.pid);
      } catch {}
      this.instances.delete(deviceId);
    }

    throw new Error(
      "WebDriverAgent failed to start within 30s.\n\n" +
        "Could not find WebDriverAgentRunner process for device " +
        deviceId +
        ".\n\n" +
        "Troubleshooting:\n" +
        "1. Check simulator is running: xcrun simctl list | grep Booted\n" +
        "2. Check logs: ~/Library/Logs/CoreSimulator/" +
        deviceId +
        "/system.log\n"
    );
  }

  private async checkHealth(port: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`http://localhost:${port}/status`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  cleanup(): void {
    for (const [deviceId, instance] of this.instances) {
      try {
        process.kill(instance.pid);
      } catch {}
      const client = this.clients.get(deviceId);
      if (client) {
        client.deleteSession().catch(() => {});
      }
    }
    this.instances.clear();
    this.clients.clear();
  }
}
