import { NavLink, Outlet } from "react-router-dom";

const LINKS = [
  { to: "/", label: "Dashboard", icon: "▦" },
  { to: "/trips", label: "Trips", icon: "⇗" },
  { to: "/charging", label: "Charging", icon: "⚡" },
  { to: "/vehicle", label: "Vehicle", icon: "◉" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

function Links() {
  return (
    <>
      {LINKS.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.to === "/"}
          className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
        >
          <span aria-hidden>{l.icon}</span>
          {l.label}
        </NavLink>
      ))}
    </>
  );
}

export default function Layout() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          ID.7 Tracker
          <small>EV TELEMETRY</small>
        </div>
        <Links />
      </aside>
      <main className="main">
        <Outlet />
      </main>
      <nav className="tabbar">
        <Links />
      </nav>
    </div>
  );
}
