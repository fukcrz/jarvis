import { useEffect, useRef } from "react";
import { globalEventSchema, type GlobalEvent } from "../../shared/protocol";
import { socketUrl } from "../api";
import { subscribeEventSocket } from "../lib/event-socket";

export function useGlobalEvents(input: {
  onEvent: (event: GlobalEvent) => void;
  onResync: () => void;
}): void {
  const callbacks = useRef(input);
  callbacks.current = input;
  useEffect(() => subscribeEventSocket(socketUrl("/api/events"), {
    onMessage: (value) => {
      const event = globalEventSchema.safeParse(value);
      if (event.success) callbacks.current.onEvent(event.data);
    },
    onResync: () => callbacks.current.onResync(),
  }), []);
}
