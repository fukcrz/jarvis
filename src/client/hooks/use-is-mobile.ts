import { useEffect, useState } from "react";

/** Matches the mobile breakpoint used by styles.css. */
export const MOBILE_MAX_WIDTH_PX = 760;
export const MOBILE_MEDIA_QUERY = `(max-width: ${String(MOBILE_MAX_WIDTH_PX)}px)`;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_MEDIA_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_MEDIA_QUERY);
    const update = () => setIsMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return isMobile;
}
