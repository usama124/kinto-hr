import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
export const metadata: Metadata = {
  title: 'Kinto HR — Workspace',
  description:
    'People, attendance and payroll for teams in Pakistan. Foundation development preview.',
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <div className="shell">
          <aside className="sidebar">
            <Link href="/" className="brand" aria-label="Kinto home">
              <span className="brand-symbol">k</span> kinto
              <span className="brand-hr">HR</span>
            </Link>
            <div className="workspace-label">
              <span className="workspace-icon">K</span>
              <div>
                Kinto workspace<small>Development environment</small>
              </div>
            </div>
            <span className="nav-heading">WORKSPACE</span>
            <nav aria-label="Main navigation">
              <Link className="nav-item" href="/">
                Overview <span>01</span>
              </Link>
              <Link className="nav-item" href="/roadmap">
                Build progress <span>02</span>
              </Link>
              <Link className="nav-item" href="/setup">
                Connection guide <span>03</span>
              </Link>
              <Link className="nav-item" href="/login">
                Account access <span>04</span>
              </Link>
            </nav>
            <div className="upcoming">
              <span className="nav-heading">UPCOMING MODULES</span>
              <span>
                Employees <small>Next</small>
              </span>
              <span>
                Attendance <small>Phase 2</small>
              </span>
              <span>
                Payroll <small>Phase 3</small>
              </span>
            </div>
            <div className="sidebar-bottom">
              <span className="small-dot" /> Pakistan edition
              <small>PKR · Asia/Karachi</small>
            </div>
          </aside>
          <div className="content">
            <header className="topbar">
              <span>
                Workspace / <strong>Foundation</strong>
              </span>
              <span className="preview-badge">Development preview</span>
            </header>
            <main id="main">{children}</main>
            <footer>
              Kinto HR <span>Built around your people.</span>
              <span>v0.1 · Foundation</span>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
