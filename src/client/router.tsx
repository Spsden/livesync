import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import { RootLayout } from './routes/root'
import { RoomPage } from './routes/room'
import { BASE_PATH } from './base'
import { ROOM_RE } from './constants'
import { uid } from './ui'

const rootRoute = createRootRoute({ component: RootLayout })

// "/" is not a page: it mints a room id and replaces the history entry, so the
// notepad always has a shareable URL and back does not land on a throwaway id.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({
      to: '/n/$roomId',
      params: { roomId: uid(6) },
      replace: true,
    })
  },
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
