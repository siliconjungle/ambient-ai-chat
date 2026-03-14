"use client";

import { get, set } from "idb-keyval";

import { createRandomUsername, type AgentKind } from "@social/shared";

const PROFILE_KEY = "social-platform.profile";

export interface StoredProfile {
  id: string;
  username: string;
  kind: AgentKind;
}

export async function getOrCreateProfile(): Promise<StoredProfile> {
  const existingProfile = await readProfile();
  if (existingProfile) {
    if (existingProfile.kind === "user") {
      return existingProfile;
    }

    const nextProfile: StoredProfile = {
      ...existingProfile,
      kind: "user"
    };

    await persistProfile(nextProfile);
    return nextProfile;
  }

  const nextProfile: StoredProfile = {
    id: crypto.randomUUID(),
    username: createRandomUsername(),
    kind: "user"
  };

  await persistProfile(nextProfile);
  return nextProfile;
}

export async function persistProfile(profile: StoredProfile): Promise<void> {
  try {
    await set(PROFILE_KEY, profile);
  } catch {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  }
}

async function readProfile(): Promise<StoredProfile | null> {
  try {
    const profile = await get<StoredProfile>(PROFILE_KEY);
    if (profile?.id && profile?.username && profile?.kind) {
      return profile;
    }
  } catch {
    const rawProfile = window.localStorage.getItem(PROFILE_KEY);
    if (!rawProfile) {
      return null;
    }

    try {
      const profile = JSON.parse(rawProfile) as Partial<StoredProfile>;
      if (profile.id && profile.username && profile.kind) {
        return profile as StoredProfile;
      }
    } catch {
      return null;
    }
  }

  return null;
}
