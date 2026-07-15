import type { PackageDetail } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/package-ui";

export default function SubCalcTab({ detail }: { detail: PackageDetail }) {
  const { package: pkg, rollup } = detail;

  const rows: { label: string; amount: number; emphasis?: boolean }[] = [
    { label: "Direct Labor", amount: rollup.laborTotal },
    { label: "Fringe", amount: rollup.fringeTotal },
    { label: "Overhead", amount: rollup.overheadTotal },
    { label: "OT / DT Premium", amount: rollup.otdtPremium },
    { label: "Fixed Fee", amount: rollup.fixedFee },
    { label: "FCCM", amount: rollup.fccm },
    { label: "Other Direct Costs", amount: rollup.otherDirectCosts },
    { label: "Total This Period", amount: rollup.totalThisPeriod, emphasis: true },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Burden &amp; Fee Build-up</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.label}
                  className={row.emphasis ? "bg-[#CFAF42]/5 font-semibold" : ""}
                >
                  <TableCell>{row.label}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(row.amount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {rollup.financials.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Detailed Financials</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                {rollup.financials.map((line, i) => (
                  <TableRow
                    key={i}
                    className={line.emphasis ? "bg-gray-50 font-semibold" : ""}
                  >
                    <TableCell>{line.label}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(line.amount)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {line.note || ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
