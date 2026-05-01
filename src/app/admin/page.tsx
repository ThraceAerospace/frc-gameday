import { getAllEventKeys } from "@/lib/eventState";
import Link from "next/link";

export default async function AdminPage() {
  const keys = await getAllEventKeys();

  return (
    <div>
      <h2>Redis Events</h2>

      <ul>
        {keys.map((key) => (
          <li key={key}>
            <Link href={`/admin/events?key=${key}`}>{key}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}