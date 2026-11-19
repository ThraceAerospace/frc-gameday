import { redirect } from "next/navigation";

export default async function EventInsightsRedirect({
  params,
}: {
  params: Promise<{ event: string }>;
}) {
  const { event } = await params;
  redirect(`/event/${encodeURIComponent(event)}?tab=analytics`);
}
