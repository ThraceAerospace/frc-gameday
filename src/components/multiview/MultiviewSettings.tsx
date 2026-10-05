"use client";

import { createPortal } from "react-dom";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { LAYOUTS, pickLayout } from "@/lib/multiview/layouts";
import type { MultiviewActions } from "./MultiviewActions";
import type { MultiviewState } from "./MultiviewState";

type MultiviewSettingsProps = {
  state: MultiviewState;
  actions: MultiviewActions;
  trigger?: ReactNode;
};

export default function MultiviewSettings({
  state,
  actions,
  trigger,
}: MultiviewSettingsProps) {
  const [open, setOpen] = useState(false);
  const [eventSearch, setEventSearch] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const autoLayoutKey = pickLayout(state.streams.length || 1);
  const selectedLayoutKey =
    state.highlightLayoutKey ?? state.layoutKey ?? autoLayoutKey;

  const filteredEvents = useMemo(() => {
    const query = state.eventSearch.trim().toLowerCase();

    return state.availableEvents
      .filter((event) => !state.streams.includes(String(event.key)))
      .filter((event) => {
        if (!query) {
          return true;
        }

        return [
          event.name,
          event.short_name,
          event.key,
          event.city,
          event.state_prov,
          event.country,
        ]
          .filter(Boolean)
          .some((value) =>
            String(value).toLowerCase().includes(query)
          );
      });
  }, [state.availableEvents, state.eventSearch, state.streams]);

  const openSettings = () => setOpen(true);
  const closeSettings = () => {
    setOpen(false);
    actions.closeEventPicker();
  };

  return (
    <>
      {trigger ? (
        <span onClick={openSettings}>{trigger}</span>
      ) : null}

      {mounted && open
        ? createPortal(
            <>
        <div className="fixed inset-0 z-[100] flex h-screen w-screen flex-col bg-neutral-950 text-white">
          <header className="flex shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-950 px-6 py-4">
            <div>
              <div className="text-lg font-semibold">Multiview Settings</div>
              <div className="mt-0.5 text-xs text-neutral-500">
                Configure the Multiview Controller
              </div>
            </div>

            <button
              onClick={closeSettings}
              className="flex items-center gap-2 rounded px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 hover:text-white"
              title="Close settings"
              aria-label="Close settings"
            >
              <XMarkIcon className="h-5 w-5" />
              Close
            </button>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="mx-auto grid w-full max-w-5xl gap-6 md:grid-cols-2">
              <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                <div className="mb-4">
                  <h2 className="text-sm font-semibold">Events</h2>
                  <p className="mt-1 text-xs text-neutral-500">
                    Manage the events displayed by this Multiview.
                  </p>
                </div>

                <button
                  onClick={() => {
                    actions.openEventPicker();
                  }}
                  className="mb-4 w-full rounded bg-neutral-800 px-3 py-2 text-left text-sm hover:bg-neutral-700"
                >
                  Add Event
                </button>

                <div className="space-y-1">
                  {state.priority.map((eventKey, position) => (
                    <div
                      key={eventKey}
                      className="flex items-center justify-between rounded bg-neutral-800 px-2 py-1"
                    >
                      <span className="truncate text-xs">
                        {state.labels[eventKey] ?? `Stream ${position + 1}`}
                      </span>

                      <div className="flex gap-1">
                        <button
                          onClick={() =>
                            actions.movePriority(position, -1)
                          }
                          className="icon-button"
                          title="Move up"
                          aria-label="Move up"
                        >
                          <ArrowUpIcon />
                        </button>
                        <button
                          onClick={() =>
                            actions.movePriority(position, 1)
                          }
                          className="icon-button"
                          title="Move down"
                          aria-label="Move down"
                        >
                          <ArrowDownIcon />
                        </button>
                        <button
                          type="button"
                          onClick={() => actions.removeEvent(eventKey)}
                          className="icon-button shrink-0"
                          title={`Remove ${state.labels[eventKey] ?? eventKey}`}
                          aria-label={`Remove ${state.labels[eventKey] ?? eventKey}`}
                        >
                          <XMarkIcon />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                <div className="mb-4">
                  <h2 className="text-sm font-semibold">Behavior</h2>
                  <p className="mt-1 text-xs text-neutral-500">
                    Configure automatic Multiview behavior.
                  </p>
                </div>

                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-white">
                      Focus imminent matches
                    </div>
                    <div className="mt-1 text-[10px] leading-4 text-neutral-500">
                      Automatically highlight an event when a tracked team&apos;s
                      match is approaching.
                    </div>
                  </div>

                  <input
                    type="checkbox"
                    checked={state.autoFocusMatches}
                    onChange={(event) =>
                      actions.setAutoFocusMatches(event.target.checked)
                    }
                    className="h-4 w-4 shrink-0"
                  />
                </label>
              </section>

              <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 md:col-span-2">
                <div className="mb-4">
                  <h2 className="text-sm font-semibold">Layout</h2>
                  <p className="mt-1 text-xs text-neutral-500">
                    Choose how event views are arranged on screen.
                  </p>
                </div>

                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  <button
                    onClick={actions.resetLayout}
                    className={
                      "rounded px-3 py-2 text-left text-sm " +
                      (state.layoutKey === null
                        ? "bg-green-700"
                        : "bg-neutral-950 hover:bg-neutral-800")
                    }
                  >
                    Auto Layout ({LAYOUTS[autoLayoutKey].name})
                  </button>

                  {Object.entries(LAYOUTS).map(([key, value]) => (
                    <button
                      key={key}
                      onClick={() =>
                        actions.setLayout(
                          key as keyof typeof LAYOUTS
                        )
                      }
                      className={
                        "rounded px-3 py-2 text-left text-sm " +
                        (selectedLayoutKey === key
                          ? "bg-neutral-700"
                          : "bg-neutral-950 hover:bg-neutral-800")
                      }
                    >
                      {value.name}
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </main>
        </div>
            </>,
            document.body,
          )
        : null}

      {false ? (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4"
          onClick={actions.closeEventPicker}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
              <div className="font-bold">Add Event</div>
              <button
                onClick={() => actions.closeEventPicker()}
                className="icon-button"
                title="Close"
                aria-label="Close"
              >
                <XMarkIcon />
              </button>
            </div>

            <div className="border-b border-neutral-800 p-3">
              <input
                autoFocus
                type="text"
                value={state.eventSearch}
                onChange={(event) => actions.setEventSearch(event.target.value)}
                placeholder="Search events..."
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              />
            </div>

            <div className="min-h-0 overflow-y-auto p-2">
              {state.eventsLoading ? (
                <div className="p-6 text-center text-sm text-neutral-500">
                  Loading events...
                </div>
              ) : filteredEvents.length === 0 ? (
                <div className="p-6 text-center text-sm text-neutral-500">
                  No matching events.
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredEvents.map((event) => (
                    <button
                      key={event.key}
                      onClick={() => actions.addEvent(event)}
                      className="w-full rounded px-3 py-2 text-left transition-colors hover:bg-neutral-800"
                    >
                      <div className="truncate text-sm font-semibold">
                        {event.name ?? event.short_name ?? event.key}
                      </div>
                      <div className="mt-0.5 flex gap-2 text-xs text-neutral-500">
                        <span>{event.key}</span>
                        {event.city ? (
                          <span>
                            {event.city}
                            {event.state_prov
                              ? `, ${event.state_prov}`
                              : ""}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
