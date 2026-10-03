import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { AppShell } from './components/layout/AppShell'
import { StudioPage } from './features/studio/StudioPage'
import { EditPage } from './features/edit/EditPage'
import { AssetsPage } from './features/assets/AssetsPage'
import { AudioPage } from './features/audio/AudioPage'
import { MusicPage } from './features/music/MusicPage'
import { VideoPage } from './features/video/VideoPage'
import { ThreeDPage } from './features/threeD/ThreeDPage'
import { VisionPage } from './features/vision/VisionPage'
import { ChatPage } from './features/llm/ChatPage'
import { LibraryPage } from './features/library/LibraryPage'
import { SystemPage } from './features/system/SystemPage'

const rootRoute = createRootRoute({ component: () => <AppShell />, notFoundComponent: () => <NotFound /> })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => { throw redirect({ to: '/studio' }) },
})

const studioRoute = createRoute({ getParentRoute: () => rootRoute, path: '/studio', component: StudioPage })
const editRoute = createRoute({ getParentRoute: () => rootRoute, path: '/edit', component: EditPage })
const assetsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/assets', component: AssetsPage })
const audioRoute = createRoute({ getParentRoute: () => rootRoute, path: '/audio', component: AudioPage })
const musicRoute = createRoute({ getParentRoute: () => rootRoute, path: '/music', component: MusicPage })
const videoRoute = createRoute({ getParentRoute: () => rootRoute, path: '/video', component: VideoPage })
const threeDRoute = createRoute({ getParentRoute: () => rootRoute, path: '/3d', component: ThreeDPage })
const visionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/vision', component: VisionPage })
const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: '/chat', component: ChatPage })
const libraryRoute = createRoute({ getParentRoute: () => rootRoute, path: '/library', component: LibraryPage })
const systemRoute = createRoute({ getParentRoute: () => rootRoute, path: '/system', component: SystemPage })

const routeTree = rootRoute.addChildren([
  indexRoute, studioRoute, editRoute, assetsRoute, audioRoute, musicRoute,
  videoRoute, threeDRoute, visionRoute, chatRoute, libraryRoute, systemRoute,
])

export const router = createRouter({ routeTree, basepath: '/ui' })

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-dim">
      <div className="text-lg font-semibold">Page not found</div>
      <div className="text-sm text-ink-faint">Use the sidebar to navigate.</div>
    </div>
  )
}
