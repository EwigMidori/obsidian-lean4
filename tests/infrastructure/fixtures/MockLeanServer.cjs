const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require("vscode-jsonrpc/node");
const { spawn } = require("node:child_process");

class MockLeanServer {
  connection;

  start() {
    this.connection = createMessageConnection(
      new StreamMessageReader(process.stdin),
      new StreamMessageWriter(process.stdout),
    );
    this.connection.onRequest("initialize", () => ({ capabilities: {} }));
    this.connection.onRequest("echo", (params) => params);
    this.connection.onRequest("hold", () => new Promise(() => {}));
    this.connection.onRequest("shutdown", () => process.argv.includes("hang-shutdown") ? new Promise(() => {}) : null);
    this.connection.onRequest("descendant", () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
      return child.pid;
    });
    this.connection.onNotification("exit", () => process.exit(0));
    this.connection.onNotification("test/crash", () => process.exit(7));
    this.connection.onNotification("test/stderr", () => process.stderr.write("x".repeat(100_000)));
    this.connection.listen();
  }
}

new MockLeanServer().start();
