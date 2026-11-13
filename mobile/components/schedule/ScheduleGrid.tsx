// The office schedule as a grid, like the web board
// (components/schedule/team-schedule-view.tsx): technicians down the side,
// time across the top, bookings as blocks.
//
//   Day view   — one day; hours across, each booking a block spanning its
//                hours. Overlapping bookings stack in lanes.
//   Week view  — Mon–Sun; days across, each booking a chip on every day it
//                is booked (a Mon–Wed booking shows three chips).
//
// The top header (hours / days) and the left column (technicians) stay pinned
// while the body scrolls both ways: the body's horizontal scroll drives the
// header's translateX on the native thread (Animated.event), and the left
// column sits inside the same vertical ScrollView as the body.
//
// Which booking goes in which cell, and the hours per technician, come from
// lib/boardModel.ts — the byte-identical mirror of the web board's model.
// Geometry and hit-testing are lib/scheduleGrid.ts. This file only draws.
//
// Gestures (react-native-gesture-handler, already linked in the app):
//   tap                  → onOpen (the action sheet)
//   long-press + drag    → move to another technician (both views) or day
//                          (Week view); onMove plans and confirms it
//   long-press the grip  → (Week view, last booked day) stretch/shrink the
//   on a chip's right      booking by whole days; onResize confirms it
//   edge, then drag
// Completed jobs and stand-in (no-bookings) rows never move.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector, RefreshControl, ScrollView as GHScrollView } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import { colors, statusColors } from "../../lib/theme";
import { shortTime, shortDayLabel } from "../../lib/scheduleDisplay";
import { formatHours, dayOfLabel, type BoardBooking, type BoardCell, type BoardEntry, type BoardIndex } from "../../lib/boardModel";
import { dateKeyInBusinessTZ } from "../../lib/date";
import type { ScheduleDay } from "../../lib/scheduling";
import {
  HOUR_WIDTH,
  LANE_HEIGHT,
  LEFT_COLUMN_WIDTH,
  MIN_TOUCH,
  ROW_PADDING,
  WEEK_COLUMN_WIDTH,
  bookingEndKey,
  canResizeByDays,
  columnAt,
  dayBlockGeometry,
  dayTimelineHours,
  isCompletedJob,
  minutesIntoDay,
  moveBlockedReason,
  othersOnJobDay,
  packLanes,
  rowAt,
  rowHeight,
  rowOffsets,
  techShortLabel,
  type GridRow,
} from "../../lib/scheduleGrid";

const AnimatedGHScrollView = Animated.createAnimatedComponent(GHScrollView);

const HEADER_HEIGHT = 40;
const LONG_PRESS_MS = 350;
const GRIP_LONG_PRESS_MS = 200;
const EDGE = 48; // auto-scroll zone while dragging near an edge
const AUTO_SCROLL_STEP = 14;

export type SaveState = "saving" | "queued" | "failed";

type Placed = { entry: BoardEntry; left: number; top: number; width: number };

type Drag =
  | { kind: "move"; entry: BoardEntry; source: BoardCell; width: number }
  | { kind: "resize"; entry: BoardEntry; source: BoardCell; width: number; startX: number; startScrollX: number };

export interface ScheduleGridProps {
  view: "day" | "week";
  dayKeys: string[];
  todayKey: string;
  rows: GridRow[];
  board: BoardIndex;
  bookingsByJob: ReadonlyMap<string, BoardBooking[]>;
  bookingDays: ReadonlyMap<string, ScheduleDay[]>;
  staffNames: ReadonlyMap<string, string>;
  saveStates: ReadonlyMap<string, SaveState>;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (entry: BoardEntry) => void;
  onBlocked: (message: string) => void;
  onMove: (entry: BoardEntry, source: BoardCell, target: BoardCell) => void;
  onResize: (entry: BoardEntry, newEndKey: string) => void;
}

export function ScheduleGrid(props: ScheduleGridProps) {
  const { view, dayKeys, todayKey, rows, board, bookingsByJob, bookingDays, staffNames, saveStates } = props;
  const dayKey = dayKeys[0];

  // ---- layout --------------------------------------------------------------
  const dayRange = useMemo(() => {
    if (view !== "day") return null;
    const days: ScheduleDay[] = [];
    for (const byDay of board.byStaff.values()) for (const e of byDay.get(dayKey) ?? []) days.push(e.day);
    for (const e of board.unassigned.get(dayKey) ?? []) days.push(e.day);
    return dayTimelineHours(days, dayKey);
  }, [view, board, dayKey]);

  const columnWidth = view === "day" ? HOUR_WIDTH : WEEK_COLUMN_WIDTH;
  const columnCount = view === "day" ? dayRange!.endHour - dayRange!.startHour : dayKeys.length;
  const contentWidth = columnWidth * columnCount;

  const entriesFor = useCallback(
    (staffId: string | null, key: string): BoardEntry[] =>
      (staffId ? board.byStaff.get(staffId)?.get(key) : board.unassigned.get(key)) ?? [],
    [board],
  );

  // Every block's position inside its row, and each row's height.
  const { placedByRow, heights } = useMemo(() => {
    const placedByRow: Placed[][] = [];
    const heights: number[] = [];
    for (const row of rows) {
      const placed: Placed[] = [];
      if (view === "day") {
        const geo = entriesFor(row.staffId, dayKey).map((entry) => ({ entry, id: entry.booking.id, ...dayBlockGeometry(entry.day, dayRange!) }));
        const { lane, lanes } = packLanes(geo);
        for (const g of geo) placed.push({ entry: g.entry, left: g.left, width: g.width, top: ROW_PADDING + (lane.get(g.id) ?? 0) * LANE_HEIGHT });
        heights.push(rowHeight(lanes));
      } else {
        let lanes = 0;
        dayKeys.forEach((key, col) => {
          const list = entriesFor(row.staffId, key);
          lanes = Math.max(lanes, list.length);
          list.forEach((entry, i) =>
            placed.push({ entry, left: col * WEEK_COLUMN_WIDTH + 3, width: WEEK_COLUMN_WIDTH - 6, top: ROW_PADDING + i * LANE_HEIGHT }),
          );
        });
        heights.push(rowHeight(lanes));
      }
      placedByRow.push(placed);
    }
    return { placedByRow, heights };
  }, [rows, view, dayKey, dayKeys, dayRange, entriesFor]);
  const tops = useMemo(() => rowOffsets(heights), [heights]);
  const bodyHeight = tops.length ? tops[tops.length - 1] + heights[heights.length - 1] : 0;

  // ---- scrolling -----------------------------------------------------------
  const scrollX = useRef(new Animated.Value(0)).current;
  const headerTranslate = useMemo(() => Animated.multiply(scrollX, -1), [scrollX]);
  const scrollXNow = useRef(0);
  const scrollYNow = useRef(0);
  const hRef = useRef<GHScrollView | null>(null);
  const vRef = useRef<GHScrollView | null>(null);
  const viewportRef = useRef<View | null>(null);
  const viewport = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const onHScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
        useNativeDriver: true,
        listener: (e: { nativeEvent: { contentOffset: { x: number } } }) => {
          scrollXNow.current = e.nativeEvent.contentOffset.x;
        },
      }),
    [scrollX],
  );

  // ---- dragging ------------------------------------------------------------
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<{ row: number; col: number; endCol?: number } | null>(null);
  const ghost = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const finger = useRef({ x: 0, y: 0 });
  const autoScroll = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const hoverRef = useRef<typeof hover>(null);
  const [gridOrigin, setGridOrigin] = useState({ x: 0, y: 0 });
  const gridRef = useRef<View | null>(null);

  const measure = useCallback(() => {
    viewportRef.current?.measureInWindow((x, y, width, height) => {
      viewport.current = { x, y, width, height };
    });
    gridRef.current?.measureInWindow((x, y) => setGridOrigin({ x, y }));
  }, []);

  /** Finger (window coords) → the cell under it. */
  const cellAt = useCallback(
    (absX: number, absY: number): { row: number; col: number } | null => {
      const v = viewport.current;
      const x = absX - v.x - LEFT_COLUMN_WIDTH + scrollXNow.current;
      const y = absY - v.y + scrollYNow.current;
      const row = rowAt(tops, heights, y);
      if (row < 0) return null;
      return { row, col: columnAt(x, columnWidth, columnCount) };
    },
    [tops, heights, columnWidth, columnCount],
  );

  const stopAutoScroll = () => {
    if (autoScroll.current) clearInterval(autoScroll.current);
    autoScroll.current = null;
  };

  const updateHover = useCallback(
    (absX: number, absY: number) => {
      const d = dragRef.current;
      if (!d) return;
      let next: typeof hover = null;
      if (d.kind === "move") {
        const cell = cellAt(absX, absY);
        // Day view moves change the technician only — the time stays.
        if (cell) next = view === "day" ? { row: cell.row, col: -1 } : cell;
      } else {
        // Whole days: how many columns the grip has travelled (auto-scroll
        // included), never ending before the booking's first day.
        const startCol = dayKeys.indexOf(d.source.dateKey);
        const travelled = absX - d.startX + (scrollXNow.current - d.startScrollX);
        const delta = Math.round(travelled / WEEK_COLUMN_WIDTH);
        const firstKey = dateKeyInBusinessTZ(d.entry.booking.starts_at);
        const firstCol = firstKey < dayKeys[0] ? 0 : dayKeys.indexOf(firstKey);
        const endCol = Math.max(firstCol, Math.min(dayKeys.length - 1, startCol + delta));
        const row = rows.findIndex((r) => r.staffId === d.source.staffId);
        next = { row, col: firstCol, endCol };
      }
      const prev = hoverRef.current;
      if (prev?.row !== next?.row || prev?.col !== next?.col || prev?.endCol !== next?.endCol) {
        hoverRef.current = next;
        setHover(next);
      }
    },
    [cellAt, view, dayKeys, rows],
  );

  const tickAutoScroll = useCallback(() => {
    const v = viewport.current;
    const { x, y } = finger.current;
    let dx = 0;
    let dy = 0;
    if (x > v.x + v.width - EDGE) dx = AUTO_SCROLL_STEP;
    else if (x < v.x + LEFT_COLUMN_WIDTH + EDGE / 2 && scrollXNow.current > 0) dx = -AUTO_SCROLL_STEP;
    if (dragRef.current?.kind === "move") {
      if (y > v.y + v.height - EDGE) dy = AUTO_SCROLL_STEP;
      else if (y < v.y + EDGE / 2 && scrollYNow.current > 0) dy = -AUTO_SCROLL_STEP;
    }
    if (dx) {
      const maxX = Math.max(0, contentWidth - (v.width - LEFT_COLUMN_WIDTH));
      const nx = Math.min(maxX, Math.max(0, scrollXNow.current + dx));
      if (nx !== scrollXNow.current) {
        scrollXNow.current = nx;
        hRef.current?.scrollTo({ x: nx, animated: false });
      }
    }
    if (dy) {
      const maxY = Math.max(0, bodyHeight - v.height);
      const ny = Math.min(maxY, Math.max(0, scrollYNow.current + dy));
      if (ny !== scrollYNow.current) {
        scrollYNow.current = ny;
        vRef.current?.scrollTo({ y: ny, animated: false });
      }
    }
    if (dx || dy) updateHover(x, y);
  }, [contentWidth, bodyHeight, updateHover]);

  const beginDragNow = (d: Drag, absX: number, absY: number) => {
    if (d.kind === "resize") d = { ...d, startScrollX: scrollXNow.current };
    measure();
    dragRef.current = d;
    setDrag(d);
    finger.current = { x: absX, y: absY };
    ghost.setValue({ x: absX, y: absY });
    stopAutoScroll();
    autoScroll.current = setInterval(() => latest.current.tickAutoScroll(), 40);
    updateHover(absX, absY);
  };

  const moveDragNow = (absX: number, absY: number) => {
    finger.current = { x: absX, y: absY };
    ghost.setValue({ x: absX, y: absY });
    updateHover(absX, absY);
  };

  const endDragNow = (commit: boolean) => {
    stopAutoScroll();
    const d = dragRef.current;
    const h = hoverRef.current;
    dragRef.current = null;
    hoverRef.current = null;
    setDrag(null);
    setHover(null);
    if (!commit || !d || !h || h.row < 0) return;
    if (d.kind === "move") {
      const target: BoardCell = {
        staffId: rows[h.row].staffId,
        dateKey: view === "day" ? dayKey : dayKeys[h.col],
      };
      props.onMove(d.entry, d.source, target);
    } else if (h.endCol !== undefined) {
      const newEnd = dayKeys[h.endCol];
      if (newEnd !== d.source.dateKey) props.onResize(d.entry, newEnd);
    }
  };

  // The gesture callbacks handed to each block must keep their identity for
  // the whole drag: a new function would rebuild the block's gesture, and
  // RNGH drops a gesture that is replaced mid-flight. So the blocks get these
  // stable wrappers, and the wrappers call whatever the latest render made.
  const latest = useRef({ beginDragNow, moveDragNow, endDragNow, tickAutoScroll, onOpen: props.onOpen, onBlocked: props.onBlocked });
  latest.current = { beginDragNow, moveDragNow, endDragNow, tickAutoScroll, onOpen: props.onOpen, onBlocked: props.onBlocked };
  const beginDrag = useCallback((d: Drag, x: number, y: number) => latest.current.beginDragNow(d, x, y), []);
  const moveDrag = useCallback((x: number, y: number) => latest.current.moveDragNow(x, y), []);
  const endDrag = useCallback((commit: boolean) => latest.current.endDragNow(commit), []);
  const onOpen = useCallback((e: BoardEntry) => latest.current.onOpen(e), []);
  const onBlocked = useCallback((m: string) => latest.current.onBlocked(m), []);

  // Leaving the screen mid-drag must not leave the auto-scroll timer running.
  useEffect(() => () => stopAutoScroll(), []);

  // ---- rendering -----------------------------------------------------------
  const dragging = drag !== null;

  const header =
    view === "day"
      ? Array.from({ length: columnCount }, (_, i) => {
          const h = dayRange!.startHour + i;
          return (
            <View key={h} style={[styles.headCell, { width: HOUR_WIDTH }]}>
              <Text style={styles.headText}>{`${h}:00`}</Text>
            </View>
          );
        })
      : dayKeys.map((key) => {
          const isToday = key === todayKey;
          return (
            <View key={key} style={[styles.headCell, { width: WEEK_COLUMN_WIDTH }, isToday && styles.headToday]}>
              <Text style={[styles.headText, isToday && styles.headTodayText]}>{shortDayLabel(key).replace(/ \w+$/, "")}</Text>
            </View>
          );
        });

  return (
    <View ref={gridRef} style={styles.root} onLayout={measure}>
      {/* Pinned header: corner + the time axis, moved with the body's horizontal scroll. */}
      <View style={styles.headRow}>
        <View style={[styles.corner, { width: LEFT_COLUMN_WIDTH }]}>
          <Text style={styles.cornerText}>{view === "day" ? "Technician" : "Tech / day"}</Text>
        </View>
        <View style={styles.headViewport}>
          <Animated.View style={[styles.headStrip, { width: contentWidth, transform: [{ translateX: headerTranslate }] }]}>{header}</Animated.View>
        </View>
      </View>

      <View ref={viewportRef} style={styles.flex} onLayout={(_e: LayoutChangeEvent) => measure()}>
        <GHScrollView
          ref={vRef}
          scrollEnabled={!dragging}
          scrollEventThrottle={16}
          onScroll={(e) => {
            scrollYNow.current = e.nativeEvent.contentOffset.y;
          }}
          refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} tintColor={colors.blue600} />}
        >
          <View style={styles.bodyRow}>
            {/* Pinned left column: scrolls vertically with the body, never horizontally. */}
            <View style={{ width: LEFT_COLUMN_WIDTH }}>
              {rows.map((row, i) => (
                <View
                  key={row.staffId ?? "unassigned"}
                  style={[styles.nameCell, { height: heights[i] }, hover?.row === i && styles.nameCellHover]}
                  accessibilityRole="header"
                >
                  <Text style={[styles.nameText, !row.staffId && styles.unassignedText]} numberOfLines={2}>
                    {row.name}
                  </Text>
                  {row.staffId ? <Text style={styles.hoursText}>{formatHours(row.hours)}</Text> : null}
                </View>
              ))}
            </View>

            <AnimatedGHScrollView
              ref={hRef as never}
              horizontal
              scrollEnabled={!dragging}
              showsHorizontalScrollIndicator
              scrollEventThrottle={16}
              onScroll={onHScroll}
              style={styles.flex}
            >
              <View style={{ width: contentWidth, height: bodyHeight }}>
                {/* Grid lines and shading. */}
                {rows.map((row, i) => (
                  <View key={`line-${row.staffId ?? "u"}`} style={[styles.rowLine, { top: tops[i], height: heights[i], width: contentWidth }]} />
                ))}
                {Array.from({ length: columnCount }, (_, c) => {
                  const isToday = view === "week" && dayKeys[c] === todayKey;
                  return (
                    <View
                      key={`col-${c}`}
                      style={[styles.colLine, { left: c * columnWidth, width: columnWidth, height: bodyHeight }, isToday && styles.colToday]}
                    />
                  );
                })}
                {view === "day" && dayKey === todayKey ? <NowLine dayKey={dayKey} startHour={dayRange!.startHour} height={bodyHeight} width={contentWidth} /> : null}

                {/* Where a drop or a resize would land. */}
                {hover && hover.row >= 0 ? (
                  <View
                    pointerEvents="none"
                    style={[
                      styles.dropTarget,
                      {
                        top: tops[hover.row],
                        height: heights[hover.row],
                        left: hover.col < 0 ? 0 : hover.col * columnWidth,
                        width:
                          hover.col < 0
                            ? contentWidth
                            : ((hover.endCol ?? hover.col) - hover.col + 1) * columnWidth,
                      },
                    ]}
                  />
                ) : null}

                {placedByRow.map((placed, i) =>
                  placed.map((p) => (
                    <Block
                      key={`${p.entry.booking.id}:${p.entry.day.dateKey}`}
                      placed={p}
                      top={tops[i] + p.top}
                      view={view}
                      rowStaffId={rows[i].staffId}
                      staffNames={staffNames}
                      others={othersOnJobDay(p.entry, bookingsByJob.get(p.entry.booking.job_id) ?? [], bookingDays)}
                      saveState={saveStates.get(p.entry.booking.id)}
                      lifted={drag?.entry.booking.id === p.entry.booking.id}
                      onOpen={onOpen}
                      onBlocked={onBlocked}
                      onBegin={beginDrag}
                      onMove={moveDrag}
                      onEnd={endDrag}
                    />
                  )),
                )}
              </View>
            </AnimatedGHScrollView>
          </View>
        </GHScrollView>
      </View>

      {/* The block under the finger while moving it. */}
      {drag?.kind === "move" ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.ghost,
            {
              width: Math.min(drag.width, 180),
              transform: [
                { translateX: Animated.add(ghost.x, -gridOrigin.x - Math.min(drag.width, 180) / 2) },
                { translateY: Animated.add(ghost.y, -gridOrigin.y - LANE_HEIGHT) },
              ],
            },
          ]}
        >
          <Text style={styles.blockNumber} numberOfLines={1}>
            #{drag.entry.job.job_number}
          </Text>
          <Text style={styles.blockTitle} numberOfLines={1}>
            {drag.entry.job.title}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

function NowLine({ dayKey, startHour, height, width }: { dayKey: string; startHour: number; height: number; width: number }) {
  // Re-drawn with the grid; a minute of drift is fine.
  const x = (minutesIntoDay(new Date().toISOString(), dayKey) / 60 - startHour) * HOUR_WIDTH;
  if (x <= 0 || x >= width) return null;
  return <View pointerEvents="none" style={[styles.nowLine, { left: x, height }]} />;
}

interface BlockProps {
  placed: Placed;
  top: number;
  view: "day" | "week";
  rowStaffId: string | null;
  staffNames: ReadonlyMap<string, string>;
  others: string[];
  saveState: SaveState | undefined;
  lifted: boolean;
  onOpen: (entry: BoardEntry) => void;
  onBlocked: (message: string) => void;
  onBegin: (d: Drag, absX: number, absY: number) => void;
  onMove: (absX: number, absY: number) => void;
  onEnd: (commit: boolean) => void;
}

function Block({ placed, top, view, rowStaffId, staffNames, others, saveState, lifted, onOpen, onBlocked, onBegin, onMove, onEnd }: BlockProps) {
  const { entry, left, width } = placed;
  const { job, booking, day } = entry;
  const completed = isCompletedJob(job);
  const blocked = moveBlockedReason(job, booking);
  const source: BoardCell = { staffId: rowStaffId, dateKey: day.dateKey };
  const narrow = view === "week" || width < 120;
  const ownName = booking.staff_id ? staffNames.get(booking.staff_id) ?? null : null;
  const label = booking.staff_id ? techShortLabel(ownName, narrow) : null;
  const more = others.length > 0 ? `+${others.length}` : null;
  const tone = completed ? null : statusColors[job.status] ?? null;
  const showGrip = view === "week" && !blocked && canResizeByDays(booking) && day.dateKey === bookingEndKey(booking);

  const gesture = useMemo(() => {
    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd((_e, ok) => {
        if (ok) onOpen(entry);
      });
    if (blocked) {
      const hold = Gesture.LongPress()
        .runOnJS(true)
        .minDuration(LONG_PRESS_MS)
        .onStart(() => onBlocked(blocked));
      return Gesture.Exclusive(hold, tap);
    }
    let ended = false;
    const pan = Gesture.Pan()
      .runOnJS(true)
      .activateAfterLongPress(LONG_PRESS_MS)
      .onStart((e) => {
        ended = false;
        onBegin({ kind: "move", entry, source, width }, e.absoluteX, e.absoluteY);
      })
      .onUpdate((e) => onMove(e.absoluteX, e.absoluteY))
      .onEnd(() => {
        ended = true;
        onEnd(true);
      })
      .onFinalize((_e, ok) => {
        // Cancelled by the system (a call, the app backgrounded): drop the drag, change nothing.
        if (ok && !ended) onEnd(false);
      });
    return Gesture.Exclusive(pan, tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, blocked, rowStaffId, width, onOpen, onBlocked, onBegin, onMove, onEnd]);

  const grip = useMemo(() => {
    let ended = false;
    return Gesture.Pan()
      .runOnJS(true)
      .activateAfterLongPress(GRIP_LONG_PRESS_MS)
      .onStart((e) => {
        ended = false;
        onBegin({ kind: "resize", entry, source, width, startX: e.absoluteX, startScrollX: -1 }, e.absoluteX, e.absoluteY);
      })
      .onUpdate((e) => onMove(e.absoluteX, e.absoluteY))
      .onEnd(() => {
        ended = true;
        onEnd(true);
      })
      .onFinalize((_e, ok) => {
        if (ok && !ended) onEnd(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, rowStaffId, width, onBegin, onMove, onEnd]);

  const names = [ownName ?? (booking.staff_id ? "Technician" : "Unassigned"), ...others.map((id) => staffNames.get(id) ?? "Technician")];
  const a11y = [
    `Job ${job.job_number}, ${job.title}`,
    job.customers?.name,
    `${shortTime(day.startIso)} to ${shortTime(day.endIso)}`,
    dayOfLabel(entry),
    names.join(", "),
    completed ? "completed" : null,
    saveState === "saving" ? "saving" : saveState === "queued" ? "not on the server yet" : saveState === "failed" ? "not saved" : null,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityHint={blocked ? "Opens the job menu" : "Opens the job menu. Long-press and drag to move."}
        onAccessibilityTap={() => onOpen(entry)}
        style={[
          styles.block,
          { left, top, width, height: LANE_HEIGHT - 6 },
          tone ? { backgroundColor: tone.bg, borderColor: tone.text } : null,
          completed && styles.blockDone,
          lifted && styles.blockLifted,
          saveState === "failed" && styles.blockFailed,
        ]}
      >
        <View style={styles.blockTop}>
          <Text style={[styles.blockNumber, completed && styles.doneText]} numberOfLines={1}>
            {completed ? "✓ " : ""}#{job.job_number}
          </Text>
          {label || more ? (
            <Text style={[styles.techBadge, completed && styles.doneText]} numberOfLines={1}>
              {label ?? ""}
              {more ? <Text style={styles.moreText}>{label ? ` ${more}` : more}</Text> : null}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.blockTitle, completed && styles.doneText]} numberOfLines={1}>
          {completed ? "Completed · " : ""}
          {saveState === "saving" ? "Saving… · " : saveState === "queued" ? "Not synced yet · " : saveState === "failed" ? "Not saved · " : ""}
          {view === "week" ? `${shortTime(day.startIso)} ` : ""}
          {job.title}
        </Text>
        {showGrip ? (
          <GestureDetector gesture={grip}>
            <View style={styles.grip} hitSlop={{ top: 6, bottom: 6, left: 10, right: 6 }} accessibilityLabel="Stretch or shrink by days">
              <Ionicons name="reorder-two" size={14} color={colors.slate500} style={{ transform: [{ rotate: "90deg" }] }} />
            </View>
          </GestureDetector>
        ) : null}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.card },
  flex: { flex: 1 },
  headRow: { flexDirection: "row", height: HEADER_HEIGHT, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.card, zIndex: 2 },
  corner: { justifyContent: "center", paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: colors.border },
  cornerText: { fontSize: 11, fontWeight: "700", color: colors.slate500, textTransform: "uppercase" },
  headViewport: { flex: 1, overflow: "hidden" },
  headStrip: { flexDirection: "row", height: HEADER_HEIGHT },
  headCell: { justifyContent: "center", paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: colors.border },
  headText: { fontSize: 12, fontWeight: "700", color: colors.slate700 },
  headToday: { backgroundColor: colors.blue100 },
  headTodayText: { color: colors.blue600 },
  bodyRow: { flexDirection: "row" },
  nameCell: {
    justifyContent: "center",
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    backgroundColor: colors.card,
    minHeight: MIN_TOUCH,
  },
  nameCellHover: { backgroundColor: colors.blue100 },
  nameText: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
  unassignedText: { color: colors.orange700 },
  hoursText: { fontSize: 11, color: colors.slate500, marginTop: 2 },
  rowLine: { position: "absolute", left: 0, borderBottomWidth: 1, borderBottomColor: colors.border },
  colLine: { position: "absolute", top: 0, borderRightWidth: 1, borderRightColor: colors.slate100 },
  colToday: { backgroundColor: "rgba(37,99,235,0.05)" },
  nowLine: { position: "absolute", top: 0, width: 2, backgroundColor: colors.red600, opacity: 0.6 },
  dropTarget: { position: "absolute", backgroundColor: "rgba(37,99,235,0.12)", borderWidth: 2, borderColor: colors.blue500, borderRadius: 6 },
  block: {
    position: "absolute",
    borderRadius: 8,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderColor: colors.blue600,
    backgroundColor: colors.blue100,
    paddingHorizontal: 6,
    paddingVertical: 3,
    overflow: "hidden",
    minHeight: MIN_TOUCH,
    minWidth: MIN_TOUCH,
  },
  blockDone: { backgroundColor: colors.slate100, borderColor: colors.slate400, borderStyle: "dashed", opacity: 0.85 },
  blockLifted: { opacity: 0.35 },
  blockFailed: { borderColor: colors.red600, borderWidth: 2 },
  blockTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 },
  blockNumber: { fontSize: 12, fontWeight: "800", color: colors.slate900, flexShrink: 1 },
  blockTitle: { fontSize: 11, color: colors.slate700, marginTop: 1, paddingRight: 12 },
  techBadge: { fontSize: 10, fontWeight: "700", color: colors.slate700, backgroundColor: "rgba(255,255,255,0.7)", borderRadius: 4, paddingHorizontal: 3 },
  moreText: { color: colors.blue600 },
  doneText: { color: colors.slate500 },
  grip: { position: "absolute", right: 0, top: 0, bottom: 0, width: 18, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.6)" },
  ghost: {
    position: "absolute",
    left: 0,
    top: 0,
    height: LANE_HEIGHT - 6,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.blue600,
    backgroundColor: colors.card,
    paddingHorizontal: 6,
    paddingVertical: 3,
    shadowColor: colors.black,
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
    zIndex: 10,
  },
});
