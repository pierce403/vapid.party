import { Container } from '@cloudflare/containers';
import type { Env } from './types';

export class XmtpListenerContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  pingEndpoint = 'livez';
  sleepAfter = '10m';
  enableInternet = true;

  override async onActivityExpired(): Promise<void> {
    // SubscribeAll is intentional background activity. Keep this singleton awake;
    // the minute cron separately starts and checks the process after real exits.
    this.renewActivityTimeout();
  }
}
