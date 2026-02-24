import Link from "next/link";

export default function HomePage() {
  return (
    <main className="shell">
      <section className="panel">
        <h1>PureLuxe Scheduler</h1>
        <p>Use the booking widget or admin panel.</p>
        <div className="actions">
          <Link href="/book" className="button">
            Open Booking Widget
          </Link>
          <Link href="/admin" className="button button-outline">
            Open Admin Panel
          </Link>
        </div>
      </section>
    </main>
  );
}
