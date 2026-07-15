"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"

import { cn } from "@/lib/utils"
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react"

// Unlike Radix's Select.Value, Base UI's <Select.Value> does NOT read the
// rendered children of the selected <Select.Item> to figure out its label --
// it only resolves a label from an `items` map/array passed to the Select
// root. Since none of this app's Select usages pass that prop, the trigger
// falls back to showing the raw stored `value` (a UUID/id/enum string) once
// something is picked, instead of the human-readable text rendered inside
// the option ("tech names and jobs being code after selected").
//
// Fix: each SelectItem below reports the text it actually rendered (read
// straight from the DOM, so it's an exact match for whatever JSX the
// callsite renders -- plain string, `{name} ({role})`, etc.) into a small
// registry keyed by its `value`. SelectValue looks up the current value in
// that registry instead of stringifying it. Base UI keeps the item list
// mounted (hidden) even while the popup is closed (for closed-trigger
// typeahead), so labels are registered and available immediately -- e.g. an
// already-assigned technician shows their name on first render, not just
// after the dropdown is opened once. This is centralized here so none of
// the ~20 call sites across the app need to change.
//
// Note on why this uses a subscribe/getSnapshot store instead of plain
// context state: the <Select> wrapper below sits *above* the whole
// trigger/content tree, but that entire tree is handed to it as
// `props.children` by the call site. When only the wrapper's own state
// changes (a new label registered) while the call site itself hasn't
// re-rendered, `props.children` is the exact same element reference as
// before -- so React bails out of re-rendering everything under
// <SelectPrimitive.Root>, and SelectValue never sees the update. Using
// useSyncExternalStore inside SelectValue itself means SelectValue
// re-renders itself directly on registry changes, regardless of what its
// ancestors do.
interface SelectLabelRegistry {
  map: Map<string, string>;
  register: (key: string, label: string) => void;
  subscribe: (onChange: () => void) => () => void;
  getVersion: () => number;
}
function createSelectLabelRegistry(): SelectLabelRegistry {
  const map = new Map<string, string>();
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    map,
    register(key, label) {
      if (map.get(key) === label) return;
      map.set(key, label);
      version += 1;
      listeners.forEach((listener) => listener());
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getVersion: () => version,
  };
}
const SelectLabelRegistryContext = React.createContext<SelectLabelRegistry | null>(null);

function Select<Value = unknown, Multiple extends boolean | undefined = false>(
  props: SelectPrimitive.Root.Props<Value, Multiple>
) {
  const registryRef = React.useRef<SelectLabelRegistry | null>(null);
  if (!registryRef.current) registryRef.current = createSelectLabelRegistry();
  return (
    <SelectLabelRegistryContext.Provider value={registryRef.current}>
      <SelectPrimitive.Root {...props} />
    </SelectLabelRegistryContext.Provider>
  );
}

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  )
}

function SelectValue({ className, placeholder, ...props }: SelectPrimitive.Value.Props) {
  const registry = React.useContext(SelectLabelRegistryContext);
  // Forces this component specifically to re-render whenever a label is
  // (re-)registered, even though the ancestor tree above it may bail out
  // (see the comment above createSelectLabelRegistry for why that happens).
  React.useSyncExternalStore(
    registry?.subscribe ?? (() => () => {}),
    registry?.getVersion ?? (() => 0),
    registry?.getVersion ?? (() => 0)
  );
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("flex flex-1 text-left", className)}
      placeholder={placeholder}
      {...props}
    >
      {(value: unknown) => {
        if (value == null || value === "") return placeholder ?? "";
        const label = registry?.map.get(String(value));
        return label ?? String(value);
      }}
    </SelectPrimitive.Value>
  )
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
        }
      />
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  >) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn("relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95", className )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  value,
  ...props
}: SelectPrimitive.Item.Props) {
  const registry = React.useContext(SelectLabelRegistryContext);
  const textRef = React.useRef<HTMLDivElement | null>(null);
  React.useLayoutEffect(() => {
    if (!registry || value == null) return;
    const text = textRef.current?.textContent;
    if (text) registry.register(String(value), text);
  });
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      value={value}
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText ref={textRef} className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronUpIcon
      />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronDownIcon
      />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
