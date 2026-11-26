import React from "react";
import {createRoot} from "react-dom/client";
import AdminOperationsDashboard from "../../web/src/app/admin/runtime/AdminOperationsDashboard";
import "./generated.css";
createRoot(document.getElementById("root")!).render(<React.StrictMode><AdminOperationsDashboard/></React.StrictMode>);
