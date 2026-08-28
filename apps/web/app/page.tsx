import Link from 'next/link';
import { ConnectionStatus } from './connection-status';
export default function Home() {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">A BETTER PLACE TO WORK</p>
          <h1>Your people. One workspace.</h1>
          <p className="subtitle">
            A clear home for your team, their time, and their pay.
          </p>
        </div>
        <span className="edition">PAKISTAN / 01</span>
      </div>
      <section className="hero">
        <div className="hero-copy">
          <span className="tag">THE FOUNDATION IS TAKING SHAPE</span>
          <h2>
            Good HR starts
            <br />
            with a solid foundation.
          </h2>
          <p>
            We’re building Kinto one verified step at a time. Company isolation
            and reliable records come first. Employee workflows are next.
          </p>
          <Link className="primary-button" href="/roadmap">
            Explore the build plan <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="art-label">PEOPLE FIRST</div>
          <div className="art-center">k</div>
          <div className="art-caption">
            A connected workplace,
            <br />
            from the ground up.
          </div>
        </div>
      </section>
      <ConnectionStatus />
      <section aria-labelledby="next-heading">
        <div className="section-heading">
          <h2 id="next-heading">The workspace ahead</h2>
          <span>Three connected essentials</span>
        </div>
        <div className="module-grid">
          <article className="module">
            <span className="module-number">01 / PEOPLE</span>
            <h3>Employee management</h3>
            <p>
              Profiles, organization structure and employee history, with access
              that stays inside your company.
            </p>
            <span className="module-state">Next implementation slice</span>
          </article>
          <article className="module">
            <span className="module-number">02 / TIME</span>
            <h3>Attendance &amp; leave</h3>
            <p>
              ZKTeco K50 records, shift rules and approved leave, brought
              together before payday.
            </p>
            <span className="module-state">Hardware validation required</span>
          </article>
          <article className="module">
            <span className="module-number">03 / PAY</span>
            <h3>Pakistan payroll</h3>
            <p>
              Reviewable calculations, independent approval and payslips that
              explain every amount.
            </p>
            <span className="module-state">Payroll review required</span>
          </article>
        </div>
      </section>
      <div className="notice">
        <strong>A foundation preview, not a live HR system.</strong>
        <p>
          Sign-in is disabled by default and employee HTTP access remains
          closed. This preview contains no customer records and cannot process
          attendance, payroll or payments.
        </p>
        <Link href="/setup">Read the connection guide →</Link>
      </div>
    </>
  );
}
