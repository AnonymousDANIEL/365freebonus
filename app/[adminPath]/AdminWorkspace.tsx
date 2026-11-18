"use client";

import dynamic from "next/dynamic";

// This route also serves public brand pages. Load management assets only when
// the server has authenticated the request and renders the workspace.
export default dynamic(() => import("./AdminClient"));
