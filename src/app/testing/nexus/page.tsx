"use client";

import { useNexus } from "@/components/eventview/hooks/useNexus";
import { NexusData, NexusPartsRequest, NexusAnnouncement } from "@/lib/nexus/types";

export default function NexusTest() {
    const {
        data: nexusData,
        loading,
        error,
    } = useNexus("demo3836");

    if (loading) {
        return <div>Loading Nexus data...</div>;
    }

    if (error) {
        return <div>Nexus error: {error.message}</div>;
    }

    if (!nexusData) {
        return <div>No Nexus data available.</div>;
    }

    return (
        <div>
            <h1>Nexus Test</h1>

            <p>
                <strong>Event:</strong> {nexusData.eventKey}
            </p>

            <p>
                <strong>Data as of:</strong>{" "}
                {new Date(nexusData.dataAsOfTime).toLocaleString()}
            </p>

            <p>
                <strong>Now queuing:</strong> {nexusData.nowQueuing}
            </p>

            <p>
                <strong>Announcements:</strong> {nexusData.announcements.entries().map(([key, value]) => (
                    <div key={key}>
                        <strong>{nexusData.announcements[key].announcement}:</strong> {new Date(nexusData.announcements[key].postedTime).toLocaleString()}
                    </div>
                ))}
            </p>
            <p>
                <strong>Parts Requests:</strong> {nexusData.partsRequests.entries().map(([key, value]) => (
                    <div key={key}>
                        <strong>{nexusData.partsRequests[key].parts}:</strong> {new Date(nexusData.partsRequests[key].postedTime).toLocaleString()} (Requested by Team {nexusData.partsRequests[key].requestedByTeam})
                    </div>
                ))}
            </p>

            <h2>Matches</h2>

            {nexusData.matches.map((match) => (
                <div key={match.label}>
                    <strong>{match.label}</strong>{" "}
                    — {match.status}
                    <br />
                    Red: {match.redTeams.join(", ")}
                    <br />
                    Blue: {match.blueTeams.join(", ")}
                </div>
            ))}
        </div>
    );
}