import nodemailer, { type Transporter } from 'nodemailer';

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

/** SMTP mailer (Mailpit locally; SES/any SMTP in prod). Emails never contain PHI. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(private readonly opts: { host: string; port: number; from: string }) {
    this.transport = nodemailer.createTransport({ host: opts.host, port: opts.port, secure: false, connectionTimeout: 5_000 });
  }

  async send(msg: { to: string; subject: string; text: string }) {
    await this.transport.sendMail({ from: this.opts.from, ...msg });
  }
}

export class RecordingMailer implements Mailer {
  readonly sent: { to: string; subject: string; text: string }[] = [];
  async send(msg: { to: string; subject: string; text: string }) {
    this.sent.push(msg);
  }
}
