import type { SynapseArtifactDisplay } from "./model";
import type { CSSProperties, ReactNode } from "react";

import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import { ChatMarkdown } from "./chat-markdown";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

const chartColors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function SynapseArtifactView(props: { display?: SynapseArtifactDisplay; markdown: string }): ReactNode {
  const display = props.display;
  if (!display) return <ChatMarkdown>{props.markdown}</ChatMarkdown>;
  switch (display.type) {
    case "list":
      return (
        <ol className="synapse-display-list">
          {display.items.map((item, index) => (
            <li key={`${index}:${item.title}`}>
              <span>{index + 1}</span>
              <div>
                <strong>{item.title}</strong>
                {item.detail ? <small>{item.detail}</small> : null}
              </div>
              {item.status ? <em>{item.status}</em> : null}
            </li>
          ))}
        </ol>
      );
    case "table":
      return (
        <div className="synapse-display-table-scroll">
          <table className="synapse-display-table">
            <thead>
              <tr>
                {display.columns.map((column, index) => (
                  <th key={`${index}:${column}`}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {display.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {display.columns.map((_, columnIndex) => (
                    <td key={columnIndex}>{displayCellText(row[columnIndex])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "kanban":
      return (
        <div className="synapse-display-kanban">
          {display.columns.map((column, columnIndex) => (
            <section key={`${columnIndex}:${column.title}`}>
              <header>
                <strong>{column.title}</strong>
                <span>{column.items.length}</span>
              </header>
              {column.items.map((item, itemIndex) => (
                <article key={`${itemIndex}:${item.title}`}>
                  <strong>{item.title}</strong>
                  {item.detail ? <small>{item.detail}</small> : null}
                </article>
              ))}
            </section>
          ))}
        </div>
      );
    case "canvas":
      return (
        <div className="synapse-display-canvas">
          {display.items.map((item, index) => (
            <article
              key={`${index}:${item.title}`}
              style={
                {
                  "--synapse-item-x": `${clamp(item.x, 3, 88)}%`,
                  "--synapse-item-y": `${clamp(item.y, 5, 82)}%`,
                } as CSSProperties
              }
            >
              <strong>{item.title}</strong>
              {item.content ? <small>{item.content}</small> : null}
            </article>
          ))}
        </div>
      );
    case "chart":
      return <SynapseChart display={display} />;
    case "graph":
      return <SynapseGraph display={display} />;
  }
}

export function synapseDisplayLabel(display: SynapseArtifactDisplay | undefined): string | undefined {
  if (!display) return undefined;
  if (display.type === "kanban") return "Kanban";
  return `${display.type[0]!.toUpperCase()}${display.type.slice(1)}`;
}

function SynapseChart(props: { display: Extract<SynapseArtifactDisplay, { type: "chart" }> }): ReactNode {
  const keys = props.display.series.map((_, index) => `series${index}`);
  const data = props.display.labels.map((label, labelIndex) => ({
    label,
    ...Object.fromEntries(
      props.display.series.map((series, seriesIndex) => [keys[seriesIndex]!, series.values[labelIndex]]),
    ),
  }));
  const config = Object.fromEntries(
    props.display.series.map((series, index) => [
      keys[index]!,
      { label: series.name, color: chartColors[index % chartColors.length] },
    ]),
  );

  if (props.display.chartType === "pie") {
    const pieData = props.display.labels.map((label, index) => ({
      label,
      value: props.display.series[0]?.values[index] ?? 0,
    }));
    return (
      <ChartContainer
        config={{ value: { label: props.display.series[0]?.name ?? "Value" } }}
        className="synapse-display-chart"
        role="img"
        aria-label="Pie chart"
      >
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent />} />
          <Legend iconSize={8} />
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="label"
            innerRadius="38%"
            outerRadius="76%"
            isAnimationActive={false}
          >
            {pieData.map((item, index) => (
              <Cell key={`${index}:${item.label}`} fill={chartColors[index % chartColors.length]} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
    );
  }

  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" axisLine={false} tickLine={false} tickMargin={6} minTickGap={12} />
      <YAxis axisLine={false} tickLine={false} width={34} />
      <ChartTooltip content={<ChartTooltipContent />} />
    </>
  );
  return (
    <ChartContainer
      config={config}
      className="synapse-display-chart"
      role="img"
      aria-label={`${props.display.chartType === "bar" ? "Bar" : "Line"} chart`}
    >
      {props.display.chartType === "bar" ? (
        <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
          {axes}
          <Legend iconSize={8} />
          {props.display.series.map((series, index) => (
            <Bar
              key={`${index}:${series.name}`}
              dataKey={keys[index]!}
              name={series.name}
              fill={`var(--color-${keys[index]})`}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      ) : (
        <LineChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
          {axes}
          <Legend iconSize={8} />
          {props.display.series.map((series, index) => (
            <Line
              key={`${index}:${series.name}`}
              dataKey={keys[index]!}
              name={series.name}
              stroke={`var(--color-${keys[index]})`}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  );
}

function SynapseGraph(props: { display: Extract<SynapseArtifactDisplay, { type: "graph" }> }): ReactNode {
  const positions = circularGraphPositions(props.display.nodes.map((node) => node.id));
  return (
    <svg className="synapse-display-graph" viewBox="0 0 360 220" role="img" aria-label="Relationship graph">
      <g className="edges">
        {props.display.edges.map((edge, index) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) return null;
          return <line key={index} x1={source.x} y1={source.y} x2={target.x} y2={target.y} />;
        })}
      </g>
      <g className="nodes">
        {props.display.nodes.map((node) => {
          const position = positions.get(node.id)!;
          return (
            <g key={node.id} transform={`translate(${position.x} ${position.y})`}>
              <circle r="25" />
              <text textAnchor="middle" dominantBaseline="middle">
                {truncateLabel(node.label, 15)}
              </text>
              <title>{node.label}</title>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

export function circularGraphPositions(ids: readonly string[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (ids.length === 1) {
    positions.set(ids[0]!, { x: 180, y: 110 });
    return positions;
  }
  ids.forEach((id, index) => {
    const angle = (index / Math.max(1, ids.length)) * Math.PI * 2 - Math.PI / 2;
    positions.set(id, { x: 180 + Math.cos(angle) * 125, y: 110 + Math.sin(angle) * 78 });
  });
  return positions;
}

function displayCellText(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return String(value);
}

function truncateLabel(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
