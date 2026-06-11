import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import type { App } from "@slack/bolt";
import { AppRouterReceiver } from "@/lib/slack/receiver";

function sign(secret: string, ts: string, body: string): string {
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(`v0:${ts}:${body}`)
    .digest("hex");
  return `v0=${hmac}`;
}

function fakeApp(processEvent = vi.fn().mockResolvedValue(undefined)): App {
  return { processEvent } as unknown as App;
}

describe("AppRouterReceiver interactivity", () => {
  it("routes form-urlencoded payload to processEvent", async () => {
    const secret = "test_secret";
    const recv = new AppRouterReceiver(secret);
    const processEvent = vi.fn().mockImplementation(async ({ ack }) => {
      await ack();
    });
    recv.init(fakeApp(processEvent));

    const payload = JSON.stringify({
      type: "block_actions",
      actions: [{ action_id: "order_fulfill", value: "abc" }],
      user: { id: "UADMIN" },
    });
    const body = `payload=${encodeURIComponent(payload)}`;
    const ts = Math.floor(Date.now() / 1000).toString();
    const req = new Request("https://x/api/slack/events", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(secret, ts, body),
      },
    });

    const res = await recv.handle(req);
    expect(res.status).toBe(200);
    expect(processEvent).toHaveBeenCalledOnce();
    const event = (processEvent.mock.calls[0] as [unknown])[0] as {
      body: { type: string; user: { id: string } };
    };
    expect(event.body.type).toBe("block_actions");
    expect(event.body.user.id).toBe("UADMIN");
  });

  it("rejects bad signature", async () => {
    const recv = new AppRouterReceiver("real_secret");
    recv.init(fakeApp());
    const ts = Math.floor(Date.now() / 1000).toString();
    const req = new Request("https://x/api/slack/events", {
      method: "POST",
      body: "payload=%7B%7D",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": "v0=bogus",
      },
    });
    const res = await recv.handle(req);
    expect(res.status).toBe(401);
  });

  it("rejects replayed timestamp", async () => {
    const secret = "sec";
    const recv = new AppRouterReceiver(secret);
    recv.init(fakeApp());
    const ts = (Math.floor(Date.now() / 1000) - 60 * 10).toString();
    const body = "payload=%7B%7D";
    const req = new Request("https://x/api/slack/events", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(secret, ts, body),
      },
    });
    const res = await recv.handle(req);
    expect(res.status).toBe(401);
  });

  it("rejects missing payload field", async () => {
    const secret = "sec2";
    const recv = new AppRouterReceiver(secret);
    recv.init(fakeApp());
    const ts = Math.floor(Date.now() / 1000).toString();
    const body = "foo=bar";
    const req = new Request("https://x/api/slack/events", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(secret, ts, body),
      },
    });
    const res = await recv.handle(req);
    expect(res.status).toBe(400);
  });
});
