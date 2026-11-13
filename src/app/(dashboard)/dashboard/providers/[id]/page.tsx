import ProviderDetailPageClient from "./ProviderDetailPageClient";

// Thin route wrapper — all logic lives in ProviderDetailPageClient
// (the first step of the strangler-fig decomposition of this 12.8K-LOC god-component).
// The client reads the route id itself via useParams(), so no props are threaded.
export default function ProviderDetailPage() {
  return <ProviderDetailPageClient />;
}
