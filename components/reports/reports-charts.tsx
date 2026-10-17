"use client";

// The recharts half of the Reports page, split out so it can load on its own
// (next/dynamic in reports-dashboard.tsx). recharts is the heaviest thing the
// page imports; while it was a static import the stat cards and lists had to
// wait for it before the page became interactive.

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";

function money(n: number) {
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function RevenueBarChart({ data }: { data: { month: string; paid: number; outstanding: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="month" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
        <Tooltip formatter={(value: any) => money(Number(value))} />
        <Legend />
        <Bar dataKey="paid" name="Paid" fill="#22c55e" radius={[4, 4, 0, 0]} />
        <Bar dataKey="outstanding" name="Outstanding" fill="#3b82f6" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function StatusPieChart({
  data,
  colorFor,
}: {
  data: { name: string; value: number; key?: string }[];
  colorFor: (entry: { name: string; key?: string }) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={(d: any) => `${d.name} (${d.value})`}>
          {data.map((entry) => (
            <Cell key={entry.key ?? entry.name} fill={colorFor(entry)} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}
