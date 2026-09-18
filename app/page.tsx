import { isAuthenticated } from "@/lib/auth";
import { Login } from "@/components/login";
import { Dashboard } from "@/components/dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  return (await isAuthenticated()) ? <Dashboard /> : <Login />;
}
