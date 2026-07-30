import { createServer } from "node:net";

/** Ask the OS for an unused loopback port for an isolated test fixture. */
export function reserveLoopbackPort(host = "127.0.0.1") {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", rejectPort);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}
