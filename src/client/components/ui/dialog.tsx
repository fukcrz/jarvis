import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "./button";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ children, title, description, className, ...props }: ComponentProps<typeof DialogPrimitive.Content> & { title: string; description?: string; children: ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className={`dialog-content ${className ?? ""}`} {...props}>
        <div className="dialog-header">
          <div>
            <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            {description === undefined ? null : <DialogPrimitive.Description>{description}</DialogPrimitive.Description>}
          </div>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon" aria-label="Close dialog"><X size={17} /></Button>
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
