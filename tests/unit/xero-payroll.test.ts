import { describe, it, expect } from "vitest";
import {
  STATUTORY_SUPER_RATE,
  isCurrentEmployee,
  leaveFromXero,
  leaveTypeFromXero,
  matchStaff,
  payFromXero,
  xeroDate,
  type XeroEmployee,
} from "@/lib/xero-payroll";

const rates = [
  { earningsRateID: "ord", name: "Ordinary Hours", earningsType: "ORDINARYTIMEEARNINGS", ratePerUnit: "38.50" },
  { earningsRateID: "ot", name: "Overtime", earningsType: "OVERTIMEEARNINGS", ratePerUnit: "57.75" },
];
const leaveTypes = [
  { leaveTypeID: "al", name: "Annual Leave", leaveCategoryCode: "ANNUALLEAVE", leaveLoadingRate: 17.5, isPaidLeave: true },
  { leaveTypeID: "pc", name: "Personal/Carer's Leave", leaveCategoryCode: "PERSONALCARERSLEAVE", isPaidLeave: true },
  { leaveTypeID: "lsl", name: "Long Service Leave", leaveCategoryCode: "LONGSERVICELEAVE", isPaidLeave: true },
  { leaveTypeID: "unpaid", name: "Unpaid Leave", isPaidLeave: false },
];
const emp = (over: Partial<XeroEmployee> = {}): XeroEmployee => ({
  employeeID: "e1",
  firstName: "Alex",
  lastName: "Turner",
  email: "alex@example.com",
  ordinaryEarningsRateID: "ord",
  payTemplate: {
    earningsLines: [{ earningsRateID: "ord", calculationType: "USEEARNINGSRATE", numberOfUnitsPerWeek: 38 }],
    superLines: [{ contributionType: "SGC", calculationType: "STATUTORY" }],
    leaveLines: [{ leaveTypeID: "al" }, { leaveTypeID: "pc" }],
  },
  ...over,
});

describe("xeroDate", () => {
  it("reads Microsoft JSON dates and ISO strings", () => {
    expect(xeroDate("/Date(1793232000000+0000)/")).toBe("2026-10-29");
    expect(xeroDate("2026-11-03T00:00:00")).toBe("2026-11-03");
    expect(xeroDate(undefined)).toBeNull();
    expect(xeroDate("rubbish")).toBeNull();
  });
});

describe("payFromXero", () => {
  it("hourly employee on the pay item's rate, statutory super, annual leave loading", () => {
    const p = payFromXero(emp(), rates, leaveTypes);
    expect(p).toMatchObject({ hourlyRate: 38.5, hoursPerWeek: 38, superRate: STATUTORY_SUPER_RATE, leaveLoadingRate: 17.5 });
    expect(p.basis).toMatch(/Ordinary Hours — pay item rate/);
  });

  it("a rate entered on the employee's template wins over the pay item", () => {
    const p = payFromXero(
      emp({ payTemplate: { earningsLines: [{ earningsRateID: "ord", calculationType: "ENTEREARNINGSRATE", ratePerUnit: 44.2, numberOfUnitsPerWeek: 38 }] } }),
      rates,
      leaveTypes
    );
    expect(p.hourlyRate).toBe(44.2);
  });

  it("salaried: salary ÷ (hours × 52)", () => {
    const p = payFromXero(
      emp({ payTemplate: { earningsLines: [{ earningsRateID: "ord", calculationType: "ANNUALSALARY", annualSalary: 95_000, numberOfUnitsPerWeek: 38 }] } }),
      rates,
      leaveTypes
    );
    expect(p.hourlyRate).toBe(48.08); // 95,000 / 1,976
    expect(p.basis).toMatch(/Salary \$95,000/);
  });

  it("a super percentage above SG is kept as entered", () => {
    const p = payFromXero(emp({ payTemplate: { earningsLines: [{ earningsRateID: "ord" }], superLines: [{ contributionType: "SGC", calculationType: "PERCENTAGEOFEARNINGS", percentage: 12.5 }] } }), rates, leaveTypes);
    expect(p.superRate).toBe(12.5);
  });

  it("says what it could not find instead of inventing it", () => {
    const p = payFromXero(emp({ ordinaryEarningsRateID: undefined, payTemplate: { earningsLines: [], superLines: [{ contributionType: "SGC", calculationType: "FIXEDAMOUNT" }] } }), rates, leaveTypes);
    expect(p.hourlyRate).toBeNull();
    expect(p.superRate).toBeNull();
    expect(p.notes.join(" ")).toMatch(/fixed amount/);
  });

  it("falls back to the first ordinary-time line when the employee has no ordinary rate set", () => {
    const p = payFromXero(
      emp({ ordinaryEarningsRateID: undefined, payTemplate: { earningsLines: [{ earningsRateID: "ot" }, { earningsRateID: "ord", numberOfUnitsPerWeek: 38 }] } }),
      rates,
      leaveTypes
    );
    expect(p.hourlyRate).toBe(38.5);
  });
});

describe("leave", () => {
  it("maps Xero leave types to the app's", () => {
    expect(leaveTypeFromXero(leaveTypes[0])).toBe("annual");
    expect(leaveTypeFromXero(leaveTypes[1])).toBe("sick");
    expect(leaveTypeFromXero(leaveTypes[2])).toBe("long_service");
    expect(leaveTypeFromXero({ name: "Public Holiday (not worked)" })).toBe("public_holiday");
    expect(leaveTypeFromXero({ name: "Compassionate Leave" })).toBe("other");
  });

  const app = {
    leaveApplicationID: "la1",
    employeeID: "e1",
    leaveTypeID: "al",
    title: "Holiday",
    startDate: "/Date(1793232000000+0000)/",
    endDate: "/Date(1793577600000+0000)/",
    leavePeriods: [
      { numberOfUnits: 22.8, leavePeriodStatus: "PROCESSED" },
      { numberOfUnits: 7.6, leavePeriodStatus: "SCHEDULED" },
      { numberOfUnits: 7.6, leavePeriodStatus: "REQUESTED" }, // not approved
    ],
  };

  it("approved hours only, with dates and type", () => {
    expect(leaveFromXero(app, leaveTypes, "2025-07-01")).toEqual({
      xeroLeaveApplicationId: "la1",
      xeroEmployeeId: "e1",
      leaveType: "annual",
      start: "2026-10-29",
      end: "2026-11-02",
      hours: 30.4,
      title: "Holiday",
    });
  });

  it("skips unpaid, unapproved, and leave that ended before the import window", () => {
    expect(leaveFromXero({ ...app, leaveTypeID: "unpaid" }, leaveTypes, "2025-07-01")).toBeNull();
    expect(leaveFromXero({ ...app, leavePeriods: [{ numberOfUnits: 7.6, leavePeriodStatus: "REJECTED" }] }, leaveTypes, "2025-07-01")).toBeNull();
    expect(leaveFromXero(app, leaveTypes, "2026-12-01")).toBeNull();
  });
});

describe("matchStaff", () => {
  const staff = [
    { id: "s1", full_name: "Alex Turner", email: "ALEX@example.com" },
    { id: "s2", full_name: "Sam Rivera", email: "sam.r@other.com", xero_employee_id: "e2" },
    { id: "s3", full_name: "Jordan Blake", email: null },
    { id: "s4", full_name: "Casey Nguyen", email: null },
    { id: "s5", full_name: "Casey Nguyen", email: null },
  ];
  const employees: XeroEmployee[] = [
    emp(), // email match (case-insensitive)
    { employeeID: "e2", firstName: "Samuel", lastName: "Rivera", email: "different@x.com" }, // earlier link wins
    { employeeID: "e3", firstName: "jordan", lastName: "BLAKE" }, // name match
    { employeeID: "e4", firstName: "Casey", lastName: "Nguyen" }, // two Caseys: left for the admin
    { employeeID: "e5", firstName: "New", lastName: "Starter" },
  ];

  it("links by earlier link, then email, then unambiguous name", () => {
    const r = matchStaff(employees, staff);
    expect(r.matches.map((m) => [m.employee.employeeID, m.staff.id, m.how])).toEqual([
      ["e2", "s2", "linked"],
      ["e1", "s1", "email"],
      ["e3", "s3", "name"],
    ]);
    expect(r.unmatchedEmployees.map((e) => e.employeeID)).toEqual(["e4", "e5"]);
    expect(r.unmatchedStaff.map((s) => s.id)).toEqual(["s4", "s5"]);
  });
});

it("isCurrentEmployee leaves out people who have finished", () => {
  expect(isCurrentEmployee(emp(), "2026-11-15")).toBe(true);
  expect(isCurrentEmployee(emp({ status: "TERMINATED", terminationDate: "2026-09-30T00:00:00" }), "2026-11-15")).toBe(false);
  expect(isCurrentEmployee(emp({ terminationDate: "2026-12-20T00:00:00" }), "2026-11-15")).toBe(true);
});
