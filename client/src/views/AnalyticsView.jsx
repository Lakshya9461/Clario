import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  ResponsiveContainer,
  Tooltip,
  Legend,
  XAxis,
  YAxis,
  Cell,
  CartesianGrid,
} from "recharts";
import { auth } from "../auth.js";
import { Busy, Failure } from "../components/Status.jsx";

const COLOR_PALETTE = ["#2f5d50", "#7fb3a1", "#e2ded6", "#8c2f2f", "#f0a1a1", "#2f6b3f", "#a9b1b7"];

export default function AnalyticsView() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const overview = await auth.analyticsOverview();
        if (active) setData(overview);
      } catch (failure) {
        if (active) setError(failure);
      } finally {
        if (active) setBusy(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  if (busy) return <Busy label="Loading analytics…" />;
  if (error) {
    return (
      <section className="analytics">
        <h1 className="analytics__title">Admin analytics</h1>
        <Failure error={error} onRetry={() => window.location.reload()} />
      </section>
    );
  }

  const empty =
    !data ||
    (!data.sessionsTrend?.length &&
      !data.evidenceQuality?.length &&
      !data.topicsPopularity?.length &&
      !data.conceptOutcomes?.length);

  if (empty) {
    return (
      <section className="analytics">
        <h1 className="analytics__title">Admin analytics</h1>
        <div className="empty">
          <p className="empty__text">No analytics data available yet.</p>
          <p className="empty__hint">
            Start sessions and answer questions so data appears here.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="analytics">
      <div className="analytics__header">
        <h1 className="analytics__title">Admin analytics</h1>
        <p className="analytics__lede">
          Overview of sessions, evidence quality, topic popularity, and concept
          outcomes across all learners.
        </p>
      </div>

      <div className="analytics__grid">
        {/* 1. Sessions trend over time — line chart */}
        <div className="analytics__card">
          <h2 className="analytics__card-title">Sessions over time</h2>
          <div className="analytics__chart">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={data.sessionsTrend}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="sessions"
                  stroke={COLOR_PALETTE[0]}
                  strokeWidth={2}
                  dot={{ fill: COLOR_PALETTE[0] }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="analytics__card-note">
            New sessions started per day. Use the trend to see when learners are
            most active.
          </p>
        </div>

        {/* 2. Evidence quality breakdown — pie chart */}
        <div className="analytics__card">
          <h2 className="analytics__card-title">Evidence quality</h2>
          <div className="analytics__chart">
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Tooltip />
                <Legend />
                <Pie
                  data={data.evidenceQuality}
                  dataKey="count"
                  nameKey="quality"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  fill="#8884d8"
                  payloadOffset={{ x: 10, y: 10 }}
                  label
                >
                  {data.evidenceQuality.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLOR_PALETTE[index % COLOR_PALETTE.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <p className="analytics__card-note">
            Distribution of evidence quality across all concept assessments.
          </p>
        </div>

        {/* 3. Topics popularity — bar chart */}
        <div className="analytics__card">
          <h2 className="analytics__card-title">Topics by session volume</h2>
          <div className="analytics__chart">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.topicsPopularity}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis dataKey="topic" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="sessions" fill={COLOR_PALETTE[1]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="analytics__card-note">
            Number of sessions started per topic. Helps prioritise pack curation.
          </p>
        </div>

        {/* 4. Outcomes by concept distribution — stacked bar chart */}
        <div className="analytics__card">
          <h2 className="analytics__card-title">Concept outcomes</h2>
          <div className="analytics__chart">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart
                data={data.conceptOutcomes}
                stackOffset="sign"
                barCategoryGap={10}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="concept" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="demonstrated" fill={COLOR_PALETTE[5]} stack="a" />
                <Bar dataKey="developing" fill={COLOR_PALETTE[3]} stack="a" />
                <Bar dataKey="unknown" fill={COLOR_PALETTE[6]} stack="a" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="analytics__card-note">
            Stacked outcomes per concept: demonstrated, developing, unknown.
          </p>
        </div>
      </div>

      <p className="analytics__hint">
        <Link to="/admin/packs">Return to admin</Link>
      </p>
    </section>
  );
}
