import crypto from "node:crypto";
import { tba as TBA } from "@/lib/tba";
import { broadcastTBAEvent } from "@/lib/websocket";

type TBAWebhookMatch = {
  key?: string;
  event_key?: string;
  alliances?: Record<
    string,
    {
      teams?: string[];
    }
  >;
};

type TBAWebhookAward = {
  recipient_list?: Array<{
    team_number?: number | null;
  }>;
};

type TBAWebhookData = {
  verification_key?: string;
  event_key?: string;
  event?: {
    key?: string;
    [key: string]: unknown;
  };
  team_key?: string;
  team_keys?: string[];
  match_key?: string;
  match?: TBAWebhookMatch & {
    [key: string]: unknown;
  };
  awards?: TBAWebhookAward[];
};

type TBAWebhookPayload = {
  message_type?: string;
  message_data?: TBAWebhookData;
};

type WebhookAuthResult =
  | "missing"
  | "invalid"
  | "valid";

function verifyWebhook(
  payload: string,
  signature: string | null,
): WebhookAuthResult {
  if (!signature) {
    return "missing";
  }

  const secret =
    process.env.TBA_WEBHOOK_TOKEN;

  if (!secret) {
    throw new Error(
      "TBA_WEBHOOK_TOKEN is not configured",
    );
  }

  const expected =
    crypto
      .createHmac(
        "sha256",
        secret,
      )
      .update(payload)
      .digest("hex");

  const expectedBuffer =
    Buffer.from(
      expected,
      "utf8",
    );

  const signatureBuffer =
    Buffer.from(
      signature,
      "utf8",
    );

  if (
    expectedBuffer.length !==
    signatureBuffer.length
  ) {
    return "invalid";
  }

  return crypto.timingSafeEqual(
    expectedBuffer,
    signatureBuffer,
  )
    ? "valid"
    : "invalid";
}

export async function POST(
  req: Request,
) {
  const payloadText =
    await req.text();

  const signature =
    req.headers.get(
      "X-TBA-HMAC",
    );

  /*
   * TBA webhooks are authenticated with X-TBA-HMAC.
   *
   * A missing header is different from an invalid
   * signature: the latter looks like someone attempting
   * to send a webhook, while the former doesn't even
   * resemble a properly formed TBA webhook request.
   *
   * Yes, 418 is intentional.
   */
  try {
    const auth =
      verifyWebhook(
        payloadText,
        signature,
      );

    if (auth === "missing") {
      console.warn(
        "[WEBHOOK][TBA] Missing X-TBA-HMAC — I'm a teapot",
      );

      return new Response(
        "I'm a teapot",
        {
          status: 418,
        },
      );
    }

    if (auth === "invalid") {
      console.warn(
        "[WEBHOOK][TBA] Invalid HMAC",
      );

      return new Response(
        "Unauthorized",
        {
          status: 401,
        },
      );
    }
  } catch (error) {
    console.error(
      "[WEBHOOK][TBA] Failed to verify HMAC:",
      error,
    );

    return new Response(
      "Internal Server Error",
      {
        status: 500,
      },
    );
  }

  let payload: TBAWebhookPayload;

  try {
    payload =
      JSON.parse(
        payloadText,
      ) as TBAWebhookPayload;
  } catch (error) {
    console.warn(
      "[WEBHOOK][TBA] Invalid JSON payload:",
      error,
    );

    return new Response(
      "Invalid JSON",
      {
        status: 400,
      },
    );
  }

  const type =
    payload.message_type;

  const data =
    payload.message_data;

  const eventKey =
    data?.event_key ??
    data?.event?.key ??
    data?.match?.event_key;

  console.log(
    `[WEBHOOK][TBA] Received ${type ?? "unknown"}`,
  );

  try {
    switch (type) {
      /*
       * These notifications contain a complete Match
       * object. Push that object directly into any
       * currently-existing Redis match caches.
       */
      case "match_score":
      case "match_video": {
        if (data?.match) {
          await TBA.mutateMatchCaches(
            data.match,
          );
        }

        break;
      }

      /*
       * upcoming_match does not contain a complete Match.
       *
       * Merge its timing/team information into existing
       * cached match representations.
       */
      case "upcoming_match": {
        await TBA.mutateUpcomingMatch(
          data ?? {},
        );

        break;
      }

      /*
       * These notifications do not contain the changed
       * match list itself, so there is nothing useful to
       * write directly into the matches cache.
       *
       * The websocket signal causes the client to refetch.
       */
      case "schedule_updated":
      case "starting_comp_level": {
        break;
      }

      /*
       * TBA gives us the updated Event object, but not
       * the alliance/ranking/status endpoints that our
       * clients consume.
       *
       * Keep the event cache current if it already exists,
       * then let the WSS signal trigger the derived-data
       * refetches.
       */
      case "alliance_selection": {
        if (data?.event && eventKey) {
          await TBA.replaceCached(
            `/event/${eventKey}`,
            data.event,
          );
        }

        break;
      }

      /*
       * awards_posted contains the actual awards, but our
       * current service does not expose an awards endpoint.
       *
       * For now this remains a refetch signal.
       */
      case "awards_posted": {
        break;
      }

      /*
       * TBA webhook verification messages contain the
       * verification key in message_data.
       *
       * The HMAC has already been verified above.
       */
      case "verification": {
        console.log(
          `[WEBHOOK][TBA] Received Webhook Verification Code ${
            data?.verification_key ?? ""
          }`,
        );

        break;
      }

      /*
       * No cache mutation is required for these messages.
       */
      case "ping":
      case "broadcast": {
        break;
      }

      /*
       * Unknown webhook types are intentionally
       * acknowledged. TBA may add new notification
       * types that this version of Gameday does not
       * know about yet.
       */
      default: {
        console.log(
          `[WEBHOOK][TBA] Ignoring unknown message type: ${
            type ?? "undefined"
          }`,
        );

        break;
      }
    }
  } catch (error) {
    console.error(
      `[WEBHOOK][TBA] Failed to process ${type ?? "unknown"}:`,
      error,
    );

    return new Response(
      "Internal Server Error",
      {
        status: 500,
      },
    );
  }

  /*
   * Redis is now updated BEFORE this signal is sent.
   *
   * Clients receiving the WSS event therefore refetch
   * against Redis and normally get the webhook-mutated
   * data without another request to TBA.
   *
   * A broadcast failure is intentionally non-fatal:
   * the cache mutation has already succeeded, and the
   * normal polling/reconciliation path remains available.
   */
  if (eventKey) {
    try {
      await broadcastTBAEvent(
        eventKey,
        type,
      );
    } catch (error) {
      console.error(
        "[WEBHOOK][TBA] Failed to broadcast WebSocket event:",
        error,
      );
    }
  }

  return Response.json({
    ok: true,
  });
}