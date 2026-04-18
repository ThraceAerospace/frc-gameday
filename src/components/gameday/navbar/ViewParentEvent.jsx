export default function ViewParentEvent({ event, playoffAlliances }) {
    if (!event) {
        // console.log("[View Parent Event] Event is null");
        return null;
    }
    if (!event.parent_event_key) {
        // console.log("[View Parent Event] Parent event key is null");
        return null;
    }
    if (!playoffAlliances) {
        // console.log("[View Parent Event] Playoff alliances are null");
        return null;
    }
    const divisionFinalsComplete = playoffAlliances.some(a =>  a.status?.status === "won");
    // console.log("[View Parent Event] divisionFinalsComplete:", divisionFinalsComplete);
    return (
        divisionFinalsComplete ? 
        <button 
            className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded" 
            onClick={() => window.open(`/gameday/${event.parent_event_key}`, "_blank")}> View Championship
        </button> : ""

    );
}