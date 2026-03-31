import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import webpush from 'web-push';
import type { PushNotifier } from '../agent/types.js';

const USER_DATA = resolve(process.cwd(), '.user-data');
const SYSTEM_DIR = resolve(USER_DATA, 'system');
const KEYS_FILE = resolve(SYSTEM_DIR, 'vapid-keys.json');
const SUBS_FILE = resolve(SYSTEM_DIR, 'push-subscriptions.json');

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  [k: string]: any;
}

export class WebPushService implements PushNotifier {
  private publicKey = '';
  private subscriptions: PushSubscription[] = [];

  init(): void {
    mkdirSync(SYSTEM_DIR, { recursive: true });

    let keys: VapidKeys;
    if (existsSync(KEYS_FILE)) {
      keys = JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as VapidKeys;
    } else {
      keys = webpush.generateVAPIDKeys();
      writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
      console.log('Generated new VAPID keypair');
    }

    this.publicKey = keys.publicKey;
    webpush.setVapidDetails('mailto:lifeos@localhost', keys.publicKey, keys.privateKey);

    if (existsSync(SUBS_FILE)) {
      this.subscriptions = JSON.parse(readFileSync(SUBS_FILE, 'utf8')) as PushSubscription[];
      console.log(`Loaded ${this.subscriptions.length} push subscriptions`);
    }
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  async addSubscription(sub: Record<string, any>): Promise<void> {
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    this.subscriptions.push(sub as PushSubscription);
    this.save();
  }

  async removeSubscription(endpoint: string): Promise<void> {
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    this.save();
  }

  async sendToAll(title: string, body: string): Promise<void> {
    const payload = JSON.stringify({ title, body });
    const dead: string[] = [];

    await Promise.allSettled(
      this.subscriptions.map(async (sub) => {
        try {
          const res = await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            payload,
          );
          if (res.statusCode === 410) dead.push(sub.endpoint);
        } catch (err: any) {
          if (err?.statusCode === 410) dead.push(sub.endpoint);
          else console.warn('Push failed:', err?.message);
        }
      }),
    );

    if (dead.length > 0) {
      this.subscriptions = this.subscriptions.filter((s) => !dead.includes(s.endpoint));
      this.save();
    }
  }

  private save(): void {
    writeFileSync(SUBS_FILE, JSON.stringify(this.subscriptions, null, 2), 'utf8');
  }
}
