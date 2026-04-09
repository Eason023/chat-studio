import { HomePageClient } from "@/components/home-page-client"
import { getAppTitle } from "@/lib/app-config"

export default function Home() {
  return <HomePageClient appTitle={getAppTitle()} />
}
