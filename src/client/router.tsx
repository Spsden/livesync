import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import { HomePage } from './routes/home'
import { RootLayout } from './routes/root'
import { RoomPage } from './routes/room'
import { BASE_PATH } from './base'
import { ROOM_RE } from './constants'

const rootRoute = createRootRoute({ component: RootLayout })

// "/" is the landing page: it explains the product and mints an id on demand,
// so a first-time visitor is never dropped into an empty room with no context.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
})

const roomRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/n/$roomId',
  // Room names are the only access control in this app, so reject anything
  // that could not have been generated (or that could confuse the filesystem).
  beforeLoad: ({ params }) => {
    if (!ROOM_RE.test(params.roomId)) {
      throw redirect({ to: '/', replace: true })
    }
  },
  component: RoomPage,
})

const routeTree = rootRoute.addChildren([indexRoute, roomRoute])

export const router = createRouter({
  routeTree,
  // Routes are declared as '/', '/n/$roomId' regardless of where the app is
  // mounted; basepath handles the prefix so nothing else has to know.
  basepath: BASE_PATH || '/',
  defaultPreload: false,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
