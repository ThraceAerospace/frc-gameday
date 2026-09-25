import Link from "next/link";
import { TBA } from "@/lib/tba/service";
import type { TBAMatch } from "@/lib/tba/types";
import { formatAlliance } from "@/lib/tba/formatters";
import { formatEventTime } from "@/lib/time";

export default async function MatchPage({
  params,
}: {
  params: Promise<{
    event: string;
    match: string;
  }>;
}) {
  const { event: eventKey, match: matchKey } = await params;

  if (!eventKey || !matchKey) {
    return (
      <main className="min-h-screen bg-black px-6 py-10 text-white">
        <p className="text-neutral-400">Missing event or match key.</p>
      </main>
    );
  }

  let match;
  let event;

  try {
    [match, event] = await Promise.all([
      TBA.getMatch(matchKey),
      TBA.getEvent(eventKey),
    ]);
  } catch {
    return (
      <main className="min-h-screen bg-black px-6 py-10 text-white">
        <div className="mx-auto max-w-5xl">
          <h1 className="text-2xl font-semibold">Match unavailable</h1>

          <p className="mt-2 text-neutral-400">
            Could not load match <code>{matchKey}</code>.
          </p>

          <Link
            href={`/event/${eventKey}`}
            className="mt-6 inline-block text-sm text-neutral-400 hover:text-white"
          >
            ← Back to event
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-5xl px-6 py-10">
        {/* Breadcrumb */}
        <nav className="text-sm text-neutral-500">
          <Link
            href={`/event/${event.key}`}
            className="hover:text-white"
          >
            {event.name}
          </Link>

          <span className="mx-2">/</span>

          <span className="text-neutral-300">
            {formatMatchName(match)}
          </span>
        </nav>

        {/* Header */}
        <header className="mt-6 border-b border-white/10 pb-8">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div>
              <p className="font-mono text-sm text-neutral-500">
                {match.key}
              </p>

              <h1 className="mt-2 text-3xl font-bold tracking-tight">
                {formatMatchName(match)}
              </h1>

              <p className="mt-2 text-neutral-400">
                {formatMatchType(match)}
              </p>
            </div>

            <Link
              href={`/gameday?event=${event.key}`}
              className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium transition hover:bg-white/10"
            >
              Open Gameday
            </Link>
          </div>
        </header>

        {/* Match status */}
        <section className="mt-8">
          <div className="grid gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 sm:grid-cols-3">
            <InfoItem
              label="Scheduled"
              value={formatTime(match.time, event.timezone)}
            />

            <InfoItem
              label="Predicted"
              value={formatTime(match.predicted_time, event.timezone)}
            />

            <InfoItem
              label="Actual"
              value={formatTime(match.actual_time, event.timezone)}
            />
          </div>
        </section>

        {/* Alliances */}
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Alliances</h2>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <AlliancePanel
              name="Red Alliance"
              alliance={match.alliances.red}
              variant="red"
            />

            <AlliancePanel
              name="Blue Alliance"
              alliance={match.alliances.blue}
              variant="blue"
            />
          </div>
        </section>

        {/* Score */}
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Result</h2>

          <div className="mt-4 overflow-hidden rounded-xl border border-white/10">
            <div className="grid grid-cols-3 border-b border-white/10 bg-white/[0.03] px-5 py-3 text-xs font-medium uppercase tracking-wide text-neutral-500">
              <span>Alliance</span>
              <span className="text-center">Score</span>
              <span className="text-right">Result</span>
            </div>

            <ScoreRow
              name="Red"
              score={match.alliances.red.score}
              opponentScore={match.alliances.blue.score}
              variant="red"
            />

            <ScoreRow
              name="Blue"
              score={match.alliances.blue.score}
              opponentScore={match.alliances.red.score}
              variant="blue"
            />
          </div>
        </section>

        {/* Match information */}
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Match Information</h2>

          <div className="mt-4 grid gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 sm:grid-cols-2">
            <InfoItem label="Event" value={event.name} />
            <InfoItem label="Event Key" value={event.key} />
            <InfoItem label="Match Key" value={match.key} />
            <InfoItem
              label="Comp Level"
              value={match.comp_level.toUpperCase()}
            />
            <InfoItem
              label="Set Number"
              value={match.set_number}
            />
            <InfoItem
              label="Match Number"
              value={match.match_number}
            />
          </div>
        </section>

        {/* Links */}
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Links</h2>

          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              href={`/event/${event.key}`}
              className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-neutral-300 transition hover:bg-white/10 hover:text-white"
            >
              Event
            </Link>

            <ExternalLink
              href={`https://www.thebluealliance.com/match/${match.key}`}
              label="The Blue Alliance"
            />

            {match.videos?.map((video) => (
              <ExternalLink
                key={`${video.type}-${video.key}`}
                href={
                  video.type === "youtube"
                    ? `https://www.youtube.com/watch?v=${video.key}`
                    : video.key
                }
                label="Match Video"
              />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function AlliancePanel({
  name,
  alliance,
  variant,
}: {
  name: string;
  alliance: TBAMatch["alliances"]["red"];
  variant: "red" | "blue";
}) {
  const teams = alliance.team_keys ?? [];

  return (
    <div
      className={[
        "rounded-xl border p-5",
        variant === "red"
          ? "border-red-500/20 bg-red-500/[0.04]"
          : "border-blue-500/20 bg-blue-500/[0.04]",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-4">
        <h3
          className={[
            "text-sm font-semibold",
            variant === "red"
              ? "text-red-400"
              : "text-blue-400",
          ].join(" ")}
        >
          {name}
        </h3>

        <span className="font-mono text-lg font-bold">
          {formatScore(alliance.score)}
        </span>
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-3">
        {teams.map((team) => (
          <Link
            key={team}
            href={`/team/${team}`}
            className="rounded-lg border border-white/10 bg-black/30 px-3 py-3 font-mono text-sm text-neutral-200 transition hover:border-white/20 hover:bg-white/5"
          >
            {team.replace(/^frc/, "#")}
          </Link>
        ))}
      </div>
    </div>
  );
}

function ScoreRow({
  name,
  score,
  opponentScore,
  variant,
}: {
  name: string;
  score: number | null;
  opponentScore: number | null;
  variant: "red" | "blue";
}) {
  const finished =
    score != null &&
    score >= 0 &&
    opponentScore != null &&
    opponentScore >= 0;

  let result = "—";

  if (finished) {
    if (score > opponentScore) {
      result = "Win";
    } else if (score < opponentScore) {
      result = "Loss";
    } else {
      result = "Tie";
    }
  }

  return (
    <div className="grid grid-cols-3 items-center border-b border-white/10 px-5 py-4 last:border-b-0">
      <span
        className={[
          "font-medium",
          variant === "red"
            ? "text-red-400"
            : "text-blue-400",
        ].join(" ")}
      >
        {name}
      </span>

      <span className="text-center font-mono text-lg font-semibold">
        {formatScore(score)}
      </span>

      <span className="text-right text-sm text-neutral-400">
        {result}
      </span>
    </div>
  );
}

function InfoItem({
  label,
  value,
}: {
  label: string;
  value?: string | number | null;
}) {
  return (
    <div className="bg-neutral-950 px-5 py-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </dt>

      <dd className="mt-1 text-sm text-neutral-200">
        {value ?? "—"}
      </dd>
    </div>
  );
}

function ExternalLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-neutral-300 transition hover:bg-white/10 hover:text-white"
    >
      {label}
    </a>
  );
}

function formatMatchName(match: TBAMatch) {
  const level = match.comp_level.toLowerCase();

  switch (level) {
    case "qm":
      return `Qualification ${match.match_number}`;

    case "ef":
      return match.set_number != null
        ? `Eighthfinal ${match.set_number}-${match.match_number}`
        : `Eighthfinal ${match.match_number}`;

    case "qf":
      return match.set_number != null
        ? `Quarterfinal ${match.set_number}-${match.match_number}`
        : `Quarterfinal ${match.match_number}`;

    case "sf":
      return match.set_number != null
        ? `Semifinal ${match.set_number}-${match.match_number}`
        : `Semifinal ${match.match_number}`;

    case "f":
      return `Final ${match.match_number}`;

    default:
      return `${level.toUpperCase()} ${match.match_number}`;
  }
}

function formatMatchType(match: TBAMatch) {
  switch (match.comp_level.toLowerCase()) {
    case "qm":
      return "Qualification Match";
    case "ef":
      return "Eighthfinal Match";
    case "qf":
      return "Quarterfinal Match";
    case "sf":
      return "Semifinal Match";
    case "f":
      return "Final Match";
    default:
      return "Competition Match";
  }
}

function formatTime(
  timestamp: number | null | undefined,
  timezone?: string | null,
) {
  if (timestamp == null) {
    return "—";
  }

  return formatEventTime(timestamp, timezone ?? undefined);
}

function formatScore(score: number | null | undefined) {
  if (score == null || score < 0) {
    return "—";
  }

  return score;
}