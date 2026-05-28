/**
 * Env-var access for the app.
 *
 * Properties are lazy: validation runs on read, not on module-load. This means
 * importing `@/lib/config` is always safe (no top-level throws), so build-time
 * page-data collection in Next.js can import route modules without secrets
 * being set. Missing values surface only when handlers actually run.
 *
 * Error messages include the variable name AND a hint about where it's used,
 * so deploy-time failures point at the right thing to fix in the dashboard.
 */

type RequiredVar = {
  name: string;
  /** Where this value is used — included in the error message. */
  usedFor: string;
};

function required({ name, usedFor }: RequiredVar): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var: ${name}. Used for: ${usedFor}. ` +
        `Set it in Vercel → Settings → Environment Variables (or .env.local).`,
    );
  }
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

function csv(name: string): string[] {
  const v = optional(name);
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function intWithDefault(name: string, fallback: number): number {
  const v = optional(name);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(
      `Invalid integer for env var ${name}: ${v}. Must be a positive integer.`,
    );
  }
  return n;
}

function boolWithDefault(name: string, fallback: boolean): boolean {
  const v = optional(name);
  if (!v) return fallback;
  const normalized = v.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(
    `Invalid boolean for env var ${name}: ${v}. Must be one of "true", "false", "1", "0".`,
  );
}

// Custom emoji name accepted as currency in addition to :taco:. Stored as the
// emoji NAME without colons (matches Slack's `event.reaction` shape). Returns
// undefined when the env var is unset, blank, or set to the literal "taco" —
// in all those cases there is no *additional* emoji to accept.
function readAltEmojiName(): string | undefined {
  const raw = optional("TACO_ALT_EMOJI_NAME");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.includes(":")) {
    throw new Error(
      `Invalid TACO_ALT_EMOJI_NAME: ${raw}. Provide the emoji name only, without colons (e.g. "wltaco", not ":wltaco:").`,
    );
  }
  if (!/^[a-z0-9_+\-]+$/i.test(trimmed)) {
    throw new Error(
      `Invalid TACO_ALT_EMOJI_NAME: ${raw}. Allowed characters: letters, digits, underscore, hyphen, plus.`,
    );
  }
  return trimmed === "taco" ? undefined : trimmed;
}

export const config = {
  slack: {
    get botToken(): string {
      return required({
        name: "SLACK_BOT_TOKEN",
        usedFor: "Bolt App auth.test, posting messages, adding reactions",
      });
    },
    get signingSecret(): string {
      return required({
        name: "SLACK_SIGNING_SECRET",
        usedFor: "verifying inbound Slack event signatures",
      });
    },
    get botUserId(): string | undefined {
      return optional("SLACK_BOT_USER_ID");
    },
    get clientId(): string | undefined {
      return optional("SLACK_CLIENT_ID");
    },
    get clientSecret(): string | undefined {
      return optional("SLACK_CLIENT_SECRET");
    },
  },
  taco: {
    get channels(): string[] {
      return csv("TACO_CHANNELS");
    },
    get dailyAllowance(): number {
      return intWithDefault("TACO_DAILY_ALLOWANCE", 5);
    },
    get altEmojiName(): string | undefined {
      return readAltEmojiName();
    },
    get acceptedEmojis(): readonly string[] {
      const alt = readAltEmojiName();
      return alt ? ["taco", alt] : ["taco"];
    },
    get confirmationEmojiName(): string {
      return readAltEmojiName() ?? "taco";
    },
    get reactOnGive(): boolean {
      return boolWithDefault("TACO_REACT_ON_GIVE", false);
    },
  },
  admin: {
    get slackIds(): string[] {
      return csv("ADMIN_SLACK_IDS");
    },
  },
  hr: {
    get slackId(): string | undefined {
      return optional("HR_SLACK_ID");
    },
    get slackHandle(): string | undefined {
      return optional("HR_SLACK_HANDLE");
    },
  },
  get shopUrl(): string {
    return optional("NEXT_PUBLIC_SHOP_URL") ?? "/shop";
  },
  get companyName(): string {
    return optional("NEXT_PUBLIC_COMPANY_NAME") ?? "WLT";
  },
  get cronSecret(): string | undefined {
    return optional("CRON_SECRET");
  },
};

export type AppConfig = typeof config;
