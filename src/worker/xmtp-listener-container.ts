import { Container } from '@cloudflare/containers';
import type { Env } from './types';

export class XmtpListenerContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  pingEndpoint = 'livez';
  sleepAfter = '10m';
  enableInternet = true;
}
