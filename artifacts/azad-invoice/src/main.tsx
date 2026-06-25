import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setBaseUrl } from "@workspace/api-client-react";

setBaseUrl(window.location.origin);

createRoot(document.getElementById("root")!).render(<App />);
