import { getCustomerContact, logNotification, logVoiceCall } from '@slice/db';
import { ElevenLabsVoice, type VoiceProvider } from './voice';

/**
 * Outbound messaging port: SMS, voice calls, push, e-mail and internal ops calls.
 * Messages address *roles or pseudonymous ids*; a phone number is decrypted only at send time,
 * inside this adapter, so PII never sits in workflow history.
 */
export type Channel = 'sms' | 'call' | 'push' | 'email' | 'ops_call';

export interface Notification {
  channel: Channel;
  recipient: string; // 'customer:<uuid>' | 'pizzeria:<id>' | 'ops:<region>' | 'segment:...'
  message: string;
  orderId?: string;
  pizzeriaId?: string;
  /** Voice calls: what the agent should talk about, passed as ElevenLabs dynamic variables. */
  callPurpose?: string;
  callVariables?: Record<string, string | number>;
}

export interface Notifier {
  send(n: Notification): Promise<void>;
}

/** Writes every message to `notifications`; places real calls through ElevenLabs when configured. */
export class LoggingNotifier implements Notifier {
  constructor(
    private readonly voice: VoiceProvider = new ElevenLabsVoice(),
    private readonly quiet = process.env.NODE_ENV === 'test',
  ) {}

  async send(n: Notification) {
    await logNotification(n);
    if (n.channel === 'call' && n.recipient.startsWith('customer:')) {
      const contact = await getCustomerContact(n.recipient.slice('customer:'.length));
      if (contact?.phone) {
        const purpose = n.callPurpose ?? 'order_update';
        try {
          const r = await this.voice.call({ to: contact.phone, purpose, variables: { message: n.message, ...(n.callVariables ?? {}) } });
          await logVoiceCall({
            provider: this.voice.name,
            direction: 'outbound',
            conversationId: r.conversationId,
            recipient: n.recipient,
            purpose,
            status: r.dryRun ? 'dry_run' : 'initiated',
          });
        } catch (err) {
          await logVoiceCall({ provider: this.voice.name, direction: 'outbound', recipient: n.recipient, purpose, status: 'failed', summary: (err as Error).message });
        }
      }
    }
    if (!this.quiet) console.log(`[notify:${n.channel}] → ${n.recipient}: ${n.message}`);
  }
}
