"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteLocationDialog, type LocatableSite } from "./site-location-dialog";

// "Set location on map" for a site in a list (the Customer page). Shows
// whether the site has a map location — without one, auto clock-in cannot
// work there — and opens the pin dialog. Office/admin pages only.
export function SitePinButton({ site }: { site: LocatableSite }) {
  const [open, setOpen] = useState(false);
  const located = site.site_lat != null && site.site_lng != null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={`h-7 gap-1 text-xs ${located ? "text-slate-400 hover:text-blue-600" : "text-amber-700 hover:text-amber-800"}`}
        onClick={() => setOpen(true)}
        title={located ? "Adjust the map pin" : "No map location: auto clock-in won't work here. Set it on the map."}
      >
        <MapPin className="w-3 h-3" />
        {located ? "Pin" : "Set pin"}
      </Button>
      {open && <SiteLocationDialog site={site} open={open} onOpenChange={setOpen} />}
    </>
  );
}
