export default function EventInfo({ event }) {
  let title = "Loading...";
  //console.log("EventInfo render with event:", event);
  if (event.event_type === 4) { //event_type 4 = championship finals
    title = `[CMP] ${event.short_name}`;
   }
  else if (event.event_type === 3) { //event_type 3 = championship division
    title = `[CMP] ${event.short_name}`;
   }
  else if (event.event_type === 2) { //event_type 2 = district championship finals
    title = `${event.name}`;
  } else if (event.event_type === 5) { //event_type 5 = district championship division
    title = `[${event.district.abbreviation.toUpperCase()} DCMP] ${event.name.length > 20 ? event.short_name : event.name}`;
  } else if (event.event_type === 1 && event.district) { // Regular district event
    title = `[${event.district.abbreviation.toUpperCase()}] ${event.name.length > 20 ? event.short_name : event.name}`;
  } 
  else {
    title = event.name.length > 20 ? event.short_name : event.name;
  }

  return (
    <span className="text-nowrap text-sm">{title}</span>
  );
  
}