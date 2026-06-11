import type { App, Receiver, ReceiverEvent } from "@slack/bolt";
import crypto from "node:crypto";

const REPLAY_WINDOW_SECONDS = 60 * 5;

export class AppRouterReceiver implements Receiver {
  private app?: App;
  constructor(private signingSecret: string) {}

  init(app: App) {
    this.app = app;
  }

  async start() {
    // No-op for App Router — the route handler drives requests.
  }

  async stop() {
    // No-op.
  }

  async handle(req: Request): Promise<Response> {
    const rawBody = await req.text();
    const ts = req.headers.get("x-slack-request-timestamp") ?? "";
    const sig = req.headers.get("x-slack-signature") ?? "";
    if (!this.verify(ts, sig, rawBody)) {
      return new Response("invalid signature", { status: 401 });
    }

    // Slack sends events as JSON, but interactivity payloads (block_actions,
    // shortcuts, view_submission, etc.) arrive as
    // `application/x-www-form-urlencoded` with the JSON sitting under a single
    // `payload` field. Pick the decoder by content-type so HMAC stays valid
    // (we still verified against rawBody above).
    let parsed: unknown;
    const contentType = req.headers.get("content-type") ?? "";
    try {
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const form = new URLSearchParams(rawBody);
        const payload = form.get("payload");
        if (!payload) return new Response("missing payload", { status: 400 });
        parsed = JSON.parse(payload);
      } else {
        parsed = JSON.parse(rawBody);
      }
    } catch {
      return new Response("invalid body", { status: 400 });
    }

    // URL-verification handshake: short-circuit before processEvent.
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      (parsed as { type: unknown }).type === "url_verification"
    ) {
      const challenge = (parsed as { challenge?: unknown }).challenge;
      return Response.json({ challenge: typeof challenge === "string" ? challenge : "" });
    }

    if (!this.app) {
      throw new Error("AppRouterReceiver not initialized — wire it via new App({ receiver })");
    }

    let acked = false;
    let ackPayload: unknown = "";

    const event: ReceiverEvent = {
      body: parsed as ReceiverEvent["body"],
      ack: async (response) => {
        if (acked) return;
        acked = true;
        if (response instanceof Error) {
          ackPayload = response;
          return;
        }
        ackPayload = response ?? "";
      },
    };

    try {
      await this.app.processEvent(event);
    } catch (err) {
      console.error("[AppRouterReceiver] processEvent threw", err);
      return new Response("internal error", { status: 500 });
    }

    if (ackPayload instanceof Error) {
      return new Response("handler error", { status: 500 });
    }
    if (typeof ackPayload === "string") {
      return new Response(ackPayload, { status: 200 });
    }
    return Response.json(ackPayload, { status: 200 });
  }

  private verify(ts: string, sig: string, body: string): boolean {
    if (!ts || !sig) return false;
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return false;
    if (Math.abs(Date.now() / 1000 - tsNum) > REPLAY_WINDOW_SECONDS) return false;

    const base = `v0:${ts}:${body}`;
    const hmac = crypto.createHmac("sha256", this.signingSecret).update(base).digest("hex");
    const expected = `v0=${hmac}`;
    if (sig.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  }
}
