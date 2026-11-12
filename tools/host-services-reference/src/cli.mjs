import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { HostServices } from './service.mjs';
import { createHostServicesServer } from './server.mjs';

const configPath = process.env.HOST_SERVICES_CONFIG;
if (!configPath) throw new Error('Set HOST_SERVICES_CONFIG to a server-only config.mjs (see config.example.mjs)');
const config = (await import(pathToFileURL(resolve(configPath)).href)).default;
const service = new HostServices(config), server = createHostServicesServer(service);
server.listen(config.port ?? 8787, config.host ?? '127.0.0.1', () => {
  const address = server.address(); console.log(`host-services-reference listening on ${address.address}:${address.port}`);
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return; stopping = true;
  server.close(() => { service.close(); });
  server.closeIdleConnections();
});
