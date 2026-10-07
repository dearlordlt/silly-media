import { QueryClient, useQuery } from '@tanstack/react-query'
import { useClient } from './hooks'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5000 },
  },
})

export function useHealth() {
  const client = useClient()
  return useQuery({
    queryKey: ['health', client.base],
    queryFn: () => client.health(),
    refetchInterval: 5000,
    retry: 0,
  })
}

export function useModels() {
  const client = useClient()
  return useQuery({
    queryKey: ['models', client.base],
    queryFn: () => client.models(),
    refetchInterval: 8000,
  })
}

export function useLoras() {
  const client = useClient()
  return useQuery({ queryKey: ['loras', client.base], queryFn: () => client.loras() })
}

/** User LoRAs usable with one model (its LoRA family); `supported` is false for models without LoRA support. */
export function useModelLoras(model: string) {
  const client = useClient()
  return useQuery({ queryKey: ['loras', client.base, model], queryFn: () => client.modelLoras(model), enabled: !!model })
}

export function useAspectRatios() {
  const client = useClient()
  return useQuery({ queryKey: ['aspect-ratios', client.base], queryFn: () => client.aspectRatios() })
}
