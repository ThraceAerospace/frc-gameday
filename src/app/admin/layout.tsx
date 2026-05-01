export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const isAuthed = process.env.ADMIN_SECRET === "enabled";

  if (!isAuthed) {
    return <div>Admin disabled</div>;
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h1>Admin Panel</h1>
      <hr />
      {children}
    </div>
  );
}