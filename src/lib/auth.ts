import {
  amModOfAny,
  isAdmin,
} from '$lib/components/lemmy/moderation/moderation.js'
import { toast } from 'mono-svelte'
import { DEFAULT_INSTANCE_URL, instance } from '$lib/instance.js'
import { client, getClient } from '$lib/lemmy.js'
import { site } from './lemmy'
import { userSettings } from '$lib/settings.js'
import { instanceToURL, moveItem } from '$lib/util.js'
import {
  LemmyHttp,
  type GetSiteResponse,
  type MyUserInfo,
  type Community,
} from 'lemmy-js-client'
import { derived, get, writable, type Writable } from 'svelte/store'
import { MINIMUM_VERSION, versionIsSupported } from '$lib/version.js'
import { browser } from '$app/environment'
import { env } from '$env/dynamic/public'
import type { ResumableItem } from './lemmy/item'

const getDefaultProfile = (): Profile => ({
  id: -1,
  instance: get(profileData)?.defaultInstance ?? get(instance),
})

function getFromStorage<T>(key: string): T | undefined {
  if (typeof localStorage == 'undefined') return undefined
  const lc = localStorage.getItem(key)
  if (!lc) return undefined

  return JSON.parse(lc)
}

function setFromStorage(key: string, item: any, stringify: boolean = true) {
  if (typeof localStorage == 'undefined') return
  return localStorage.setItem(key, stringify ? JSON.stringify(item) : item)
}

export interface Profile {
  id: number
  instance: string
  jwt?: string
  user?: PersonData
  username?: string
  avatar?: string
  favorites?: Community[]
  color?: string
}

/**
 * What gets stored in localstorage.
 */
interface ProfileData {
  profiles: Profile[]
  profile: number
  defaultInstance?: string
}

interface PersonData extends MyUserInfo {}

interface Notifications {
  inbox: number
  reports: number
  applications: number
}

const getCookie = (key: string): string | undefined => {
  if (!browser) return undefined

  // sorry i was dying when i wrote this line
  // ask chatgpt or something to explain this for you
  return document?.cookie
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.split('=')?.[0] == key)
    ?.split('=')?.[1]
}

export let profileData = writable<ProfileData>(
  getFromStorage<ProfileData>('profileData') ?? {
    profiles: [
      {
        id: 1,
        instance: DEFAULT_INSTANCE_URL,
        username: 'Guest',
        color: '#505050',
      },
    ],
    profile: 1,
  }
)

let fetchingUser = false

export let profile = derived<Writable<ProfileData>, Profile>(
  profileData,
  (pd) => {
    const profile =
      pd.profiles.find((p) => p.id == pd.profile) ?? getDefaultProfile()

    if (profile?.jwt) {
      if (!profile.user && !fetchingUser) {
        site.set(undefined)

        fetchingUser = true

        notifications.set({ applications: 0, inbox: 0, reports: 0 })

        userFromJwt(profile.jwt, profile.instance)
          .then((res) => {
            if (!res?.user)
              toast({
                content: 'Your login has expired. Re-login to fix this issue.',
                type: 'warning',
              })

            site.set(res?.site)

            profile.user = res?.user
            profile.avatar = res?.user.local_user_view.person.avatar

            checkInbox()

            fetchingUser = false
          })
          .catch((e) => {
            fetchingUser = false
            toast({ content: e, type: 'error' })
          })
      }
    } else {
      if (browser) {
        site.set(undefined)
        client({ instanceURL: profile.instance })
          .getSite()
          .then((res) => site.set(res))
      }
    }

    instance.set(profile.instance)

    return profile
  }
)

export let notifications = writable<Notifications>({
  applications: 0,
  inbox: 0,
  reports: 0,
})

profileData.subscribe(async (pd) => {
  const serialized: ProfileData = {
    ...pd,
    profiles: pd.profiles.map((p) => serializeUser(p)),
  }

  setFromStorage('profileData', serialized)

  if (serialized.profile == -1) {
    instance?.set(get(profileData).defaultInstance ?? DEFAULT_INSTANCE_URL)
  }
  if (serialized.profiles.length == 0) {
    profileData.update((pd) => ({
      ...pd,
      profiles: [
        {
          id: 1,
          instance: DEFAULT_INSTANCE_URL,
          username: 'Guest',
        },
      ],
      profile: 1,
    }))
  }
})

if (
  env.PUBLIC_MIGRATE_COOKIE &&
  get(profileData).profiles.length == 0 &&
  env.PUBLIC_INSTANCE_URL
) {
  const jwt = getCookie('jwt')
  if (jwt) {
    new Promise(async () => {
      const user = await userFromJwt(jwt, env.PUBLIC_INSTANCE_URL ?? '')
      if (!user) return

      const result = await setUser(
        jwt,
        env.PUBLIC_INSTANCE_URL ?? '',
        user?.user.local_user_view.person.name
      )

      if (result)
        toast({
          content:
            'Your instance migrated to Photon, and you were logged in using a leftover cookie.',
          type: 'success',
        })
    })
  }
}

export async function setUser(jwt: string, inst: string, username: string) {
  try {
    new URL(instanceToURL(inst))
  } catch (err) {
    return
  }

  const user = await userFromJwt(jwt, inst)
    .then((u) => u)
    .catch((err) => {
      toast({ content: err as any, type: 'error' })
    })
  if (!user?.user) {
    toast({
      content: 'Failed to fetch your user. Is your instance down?',
      type: 'error',
    })

    return
  }

  instance.set(inst)

  profileData.update((pd) => {
    // too lazy to make a decent system
    const id = Math.floor(Math.random() * 100000)

    const newProfile: Profile = {
      id: id,
      instance: inst,
      jwt: jwt,
      username: user.user.local_user_view.person.name,
      avatar: user.user.local_user_view.person.avatar,
    }

    return {
      profile: id,
      profiles: [newProfile, ...pd.profiles],
    }
  })

  return user
}

async function userFromJwt(
  jwt: string,
  instance: string
): Promise<{ user: PersonData; site: GetSiteResponse } | undefined> {
  const sitePromise = client({ instanceURL: instance, auth: jwt }).getSite()

  let timer = setTimeout(
    () =>
      toast({
        content: `It's taking a while to fetch your user. Is your instance down?`,
        type: 'warning',
      }),
    5000
  )

  const site = await sitePromise.then((r) => {
    clearTimeout(timer)
    return r
  })

  if (!versionIsSupported(site.version, MINIMUM_VERSION)) {
    throw new Error(
      `This version of Photon only supports Lemmy instances with version ${MINIMUM_VERSION} or higher. This Lemmy instance is running: ${site.version}`
    )
  }

  const myUser = site.my_user
  if (!myUser) return undefined

  return {
    user: myUser,
    site: site,
  }
}

export function resetProfile() {
  profileData.update((p) => ({ ...p, profile: -1 }))
}

export function deleteProfile(id: number) {
  const pd = get(profileData)

  const index = pd.profiles.findIndex((p) => p.id == id)
  if (index <= -1) return

  pd.profiles.splice(index, 1)

  profileData.update((p) => ({
    ...p,
    profiles: pd.profiles,
  }))

  if (id == get(profile)?.id) {
    resetProfile()
  }
}

function serializeUser(user: Profile): Profile {
  return {
    ...user,
    user: undefined,
  }
}

instance.subscribe(async (i) => {
  try {
    // fetching site is handled by auth.ts if logged in
    if (get(profile)?.jwt) return
    const s = await new LemmyHttp(`https://${i}`).getSite()

    site.set(s)
  } catch (e) {}
})

export async function setUserID(id: number) {
  profileData.update((p) => ({ ...p, profile: id }))
  return get(profile)
}

export function moveProfile(id: number, up: boolean) {
  const pd = get(profileData)
  try {
    const index = pd.profiles.findIndex((i) => i.id == id)

    profileData.set({
      ...pd,
      profiles: moveItem(pd.profiles, index, index + (up ? -1 : 1)),
    })
  } catch (err) {
    // we dont care
  }
}

async function getNotificationCount(jwt: string, mod: boolean, admin: boolean) {
  const unreads = await getClient().getUnreadCount()

  let reports: number = 0
  let applications: number = 0

  if (mod) {
    try {
      const reportRes = await getClient().getReportCount({})

      reports =
        reportRes.comment_reports +
        reportRes.post_reports +
        (reportRes.private_message_reports ?? 0)
    } catch (e) {
      // doesn't matter
    }
  }

  if (admin) {
    try {
      const applicationRes =
        await getClient().getUnreadRegistrationApplicationCount()

      applications = applicationRes.registration_applications
    } catch (e) {
      // doesn't matter
    }
  }

  return {
    unreads: unreads.mentions + unreads.private_messages + unreads.replies,
    reports: reports,
    applications: applications,
  }
}

async function checkInbox() {
  if (!get(profile)) return

  const { user, jwt } = get(profile)!
  if (!jwt || !user) return

  const notifs = await getNotificationCount(
    jwt,
    amModOfAny(user) ?? false,
    user ? isAdmin(user) : false
  )

  notifications.set({
    inbox: notifs.unreads,
    applications: notifs.applications,
    reports: notifs.reports,
  })
}

setInterval(checkInbox, 4 * 60 * 1000)
