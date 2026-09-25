"use client";

import { useEffect, useState } from "react";
import type { TBAEvent } from "@/lib/tba/types";
import MultiviewClient from "@/components/multiview/MultiviewClient";

export const dynamic = "force-dynamic";

export default function DivisionalEvent({ params }: { params: Promise<{ parentEvent: string }> }) {
  const [data, setData] = useState<TBAEvent | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    Promise.resolve(params)
      .then(async (p) => {
        const key = p.parentEvent;

        const res = await fetch(`/api/event/${key}`, {
          cache: "no-store",
        });

        if (!res.ok) {
          throw new Error();
        }

        return res.json();
      })
      .then((parent: TBAEvent) => {
        if (!cancelled) {
          setData(parent);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [params]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-sm text-neutral-500">
        Championship event not found.
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-sm text-neutral-500">
        Loading championship…
      </div>
    );
  }

  const events = [
    ...(data.division_keys || []),
    data.key,
  ];

  return (
    <MultiviewClient
      events={events}
      isDivisional
      parentEvent={data}
    />
  );
}