import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { QUERY_KEYS, useUsers } from '../../api/queries'
import { CreateUserCard }  from './users/CreateUserCard'
import { UsersListCard }   from './users/UsersListCard'
import { NewApiKeyModal }  from './users/NewApiKeyModal'

/**
 * V2 — Page Utilisateurs.
 * Migration 1:1 de `components/UsersPanel.tsx` vers le design system V2.
 *
 * Comportement préservé :
 *  - Chargement initial via le hook partagé `useUsers()` + rafraîchissement après
 *    chaque mutation (invalidation de QUERY_KEYS.users).
 *  - Création utilisateur → modal affichant la clé API (visible une seule fois).
 *  - Toggle threshold ligne par ligne (PATCH `updateUser`).
 *  - Suppression utilisateur avec `confirm()` natif.
 *  - Erreurs API rendues en haut de page.
 */
export function UsersPage() {
  const queryClient = useQueryClient()
  const { data: users = [], error: usersLoadErr } = useUsers()
  const [usersErr,    setUsersErr]    = useState<string | null>(null)
  const [newKeyModal, setNewKeyModal] = useState<string | null>(null)

  const loadUsers = useCallback(() => {
    setUsersErr(null)
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.users })
  }, [queryClient])

  const displayErr = usersErr ?? (usersLoadErr ? (usersLoadErr instanceof Error ? usersLoadErr.message : String(usersLoadErr)) : null)

  return (
    <div className="flex flex-col gap-4">
      {displayErr && (
        <p className="text-[11px] text-destructive m-0">{displayErr}</p>
      )}

      <CreateUserCard
        onCreated={apiKey => { setNewKeyModal(apiKey); loadUsers() }}
        onError={msg => setUsersErr(msg)}
      />

      <UsersListCard
        users={users}
        reload={loadUsers}
        onError={msg => setUsersErr(msg)}
      />

      {newKeyModal && (
        <NewApiKeyModal
          apiKey={newKeyModal}
          onClose={() => setNewKeyModal(null)}
        />
      )}
    </div>
  )
}

export default UsersPage
