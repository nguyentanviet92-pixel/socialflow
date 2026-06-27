import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Shield, UserCheck, UserX, Network, Clock, Key } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'

const roleBadge = {
  admin: { label: 'Admin', cls: 'bg-red-100 text-red-700', icon: Shield },
  manager: { label: 'Manager', cls: 'bg-blue-100 text-info', icon: UserCheck },
  editor: { label: 'Editor', cls: 'bg-yellow-100 text-yellow-700', icon: UserCheck },
  user: { label: 'User', cls: 'bg-app-elevated text-app-muted', icon: UserCheck }
}

export default function UserManager() {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ email: '', password: '', role: 'user' })
  const [proxyModal, setProxyModal] = useState(null)
  const [selectedProxyIds, setSelectedProxyIds] = useState([])
  const [permModal, setPermModal] = useState(null) // { userId, userName }

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get('/users').then(r => r.data)
  })

  const { data: allProxies = [] } = useQuery({
    queryKey: ['proxies'],
    queryFn: () => api.get('/proxies').then(r => r.data)
  })

  const assignProxiesMutation = useMutation({
    mutationFn: ({ target_user_id, proxy_ids }) => api.put('/user-settings/assign-proxies', { target_user_id, proxy_ids }),
    onSuccess: () => {
      toast.success('Proxy assigned')
      setProxyModal(null)
    },
    onError: () => toast.error('Failed to assign proxy')
  })

  const openProxyModal = async (user) => {
    try {
      const res = await api.get(`/user-settings/admin-view/${user.id}`)
      setSelectedProxyIds(res.data?.proxy_ids || [])
    } catch {
      setSelectedProxyIds([])
    }
    setProxyModal({ userId: user.id, userName: user.username || user.display_name || user.email })
  }

  const addUserMutation = useMutation({
    mutationFn: (data) => api.post('/users', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      setShowAdd(false)
      setForm({ email: '', password: '', role: 'user' })
      toast.success('User created')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to create user')
  })

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, is_active }) => api.put(`/users/${id}`, { is_active }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('Updated')
    },
    onError: () => toast.error('Failed to update')
  })

  const changeRoleMutation = useMutation({
    mutationFn: ({ id, role }) => api.put(`/users/${id}`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('Role updated')
    },
    onError: () => toast.error('Failed to update role')
  })

  const deleteUserMutation = useMutation({
    mutationFn: (id) => api.delete(`/users/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('Đã xóa user')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Không thể xóa user')
  })

  // Separate pending users from active users (admin always active)
  const pendingUsers = users.filter(u => !u.is_active && u.role !== 'admin')
  const activeUsers = users.filter(u => u.is_active || u.role === 'admin')

  if (isLoading) return <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" /></div>

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-app-primary">Quản lý người dùng</h1>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 bg-info text-white px-4 py-2 rounded-lg hover:opacity-90">
          <Plus size={18} /> Thêm user
        </button>
      </div>

      {/* Pending Approval */}
      {pendingUsers.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-orange-600 mb-3 flex items-center gap-2">
            <Clock size={16} /> Chờ duyệt ({pendingUsers.length})
          </h2>
          <div className="bg-orange-50 border border-orange-200 rounded overflow-hidden">
            <div className="divide-y divide-orange-100">
              {pendingUsers.map(user => (
                <div key={user.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="font-medium text-app-primary">{user.username || user.email.split('@')[0]}</p>
                    <p className="text-sm text-app-muted">{user.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleActiveMutation.mutate({ id: user.id, is_active: true })}
                      className="px-4 py-1.5 bg-hermes text-white text-sm rounded-lg hover:bg-green-700 font-medium"
                    >
                      Duyệt
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Xóa user ${user.email}? Không thể khôi phục.`)) {
                          deleteUserMutation.mutate(user.id)
                        }
                      }}
                      className="px-3 py-1.5 text-red-600 text-sm rounded-lg border border-red-200 hover:bg-red-50"
                    >
                      Từ chối
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Active Users */}
      <div className="bg-app-surface rounded shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-app-base">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">User</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Email</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Role</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Status</th>
              <th className="px-4 py-3 text-right text-sm font-medium text-app-muted">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {activeUsers.map(user => {
              const role = roleBadge[user.role] || roleBadge.user
              const RoleIcon = role.icon
              return (
                <tr key={user.id} className="hover:bg-app-base">
                  <td className="px-4 py-3 font-medium">{user.username || user.display_name || '—'}</td>
                  <td className="px-4 py-3 text-sm text-app-muted">{user.email}</td>
                  <td className="px-4 py-3">
                    <select
                      value={user.role}
                      onChange={(e) => changeRoleMutation.mutate({ id: user.id, role: e.target.value })}
                      className="text-xs px-2 py-1 rounded-lg border border-app-border bg-app-surface"
                    >
                      <option value="user">User</option>
                      <option value="editor">Editor</option>
                      <option value="manager">Manager</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-100 text-hermes">
                      <UserCheck size={12} /> Active
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setPermModal({ userId: user.id, userName: user.username || user.display_name || user.email })}
                        className="text-sm px-3 py-1 rounded-lg border text-purple-600 border-purple-200 hover:bg-purple-50 flex items-center gap-1"
                      >
                        <Key size={12} /> Phân quyền
                      </button>
                      <button
                        onClick={() => openProxyModal(user)}
                        className="text-sm px-3 py-1 rounded-lg border text-info border-blue-200 hover:bg-blue-50 flex items-center gap-1"
                      >
                        <Network size={12} /> Proxy
                      </button>
                      <button
                        onClick={() => toggleActiveMutation.mutate({ id: user.id, is_active: false })}
                        disabled={toggleActiveMutation.isPending}
                        className="text-sm px-3 py-1 rounded-lg border text-orange-600 border-orange-200 hover:bg-orange-50"
                      >
                        Vô hiệu
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Xóa user ${user.email}? Tất cả dữ liệu sẽ bị mất.`)) {
                            deleteUserMutation.mutate(user.id)
                          }
                        }}
                        className="text-sm px-3 py-1 rounded-lg border text-red-600 border-red-200 hover:bg-red-50"
                      >
                        Xóa
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {activeUsers.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-app-dim">Chưa có user nào</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Proxy Assignment Modal */}
      {proxyModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setProxyModal(null)}>
          <div className="bg-app-surface rounded p-6 w-full max-w-md max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold mb-2">Gán proxy cho {proxyModal.userName}</h2>
            <p className="text-sm text-app-muted mb-4">Chọn proxy mà user này được phép sử dụng.</p>

            <div className="space-y-2 mb-4">
              {allProxies.length === 0 && <p className="text-sm text-app-dim text-center py-4">Chưa có proxy nào</p>}
              {allProxies.map(proxy => (
                <label
                  key={proxy.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedProxyIds.includes(proxy.id) ? 'border-blue-400 bg-blue-50' : 'border-app-border hover:bg-app-base'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedProxyIds.includes(proxy.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedProxyIds(prev => [...prev, proxy.id])
                      } else {
                        setSelectedProxyIds(prev => prev.filter(id => id !== proxy.id))
                      }
                    }}
                    className="w-4 h-4 rounded border-app-border text-info"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-app-primary">{proxy.label || `${proxy.host}:${proxy.port}`}</p>
                    <p className="text-xs text-app-dim">{proxy.host}:{proxy.port} {proxy.country ? `(${proxy.country})` : ''}</p>
                  </div>
                </label>
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setProxyModal(null)} className="px-4 py-2 border rounded-lg hover:bg-app-base">Hủy</button>
              <button
                onClick={() => assignProxiesMutation.mutate({ target_user_id: proxyModal.userId, proxy_ids: selectedProxyIds })}
                disabled={assignProxiesMutation.isPending}
                className="px-4 py-2 bg-info text-white rounded-lg hover:opacity-90"
              >
                {assignProxiesMutation.isPending ? 'Saving...' : `Lưu (${selectedProxyIds.length} proxy)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Permissions Modal */}
      {permModal && <PermissionsModal userId={permModal.userId} userName={permModal.userName} onClose={() => setPermModal(null)} />}

      {/* Add User Modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowAdd(false)}>
          <div className="bg-app-surface rounded p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold mb-4">Thêm user</h2>
            <p className="text-sm text-app-muted mb-4">User được admin tạo sẽ tự động active.</p>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-app-primary mb-1">Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  placeholder="user@example.com"
                  className="w-full border rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-app-primary mb-1">Mật khẩu</label>
                <input
                  type="password"
                  value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                  placeholder="Tối thiểu 6 ký tự"
                  className="w-full border rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-app-primary mb-1">Role</label>
                <select
                  value={form.role}
                  onChange={e => setForm({ ...form, role: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2"
                >
                  <option value="user">User</option>
                  <option value="editor">Editor</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowAdd(false)} className="px-4 py-2 border rounded-lg hover:bg-app-base">Hủy</button>
              <button
                onClick={() => addUserMutation.mutate(form)}
                className="px-4 py-2 bg-info text-white rounded-lg hover:opacity-90"
                disabled={addUserMutation.isPending || !form.email || !form.password}
              >
                {addUserMutation.isPending ? 'Creating...' : 'Tạo user'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PermissionsModal({ userId, userName, onClose }) {
  const [selected, setSelected] = useState({ account: [], fanpage: [], group: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Load all available resources + current permissions
  const { data: resources } = useQuery({
    queryKey: ['all-resources'],
    queryFn: () => api.get('/permissions/resources/all').then(r => r.data),
  })

  useEffect(() => {
    api.get(`/permissions/${userId}`).then(res => {
      const perms = res.data || []
      const grouped = { account: [], fanpage: [], group: [] }
      perms.forEach(p => {
        if (grouped[p.resource_type]) {
          grouped[p.resource_type].push(p.resource_id)
        }
      })
      setSelected(grouped)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [userId])

  const toggle = (type, id) => {
    setSelected(prev => ({
      ...prev,
      [type]: prev[type].includes(id)
        ? prev[type].filter(x => x !== id)
        : [...prev[type], id]
    }))
  }

  const selectAll = (type, ids) => {
    setSelected(prev => ({
      ...prev,
      [type]: prev[type].length === ids.length ? [] : ids
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const permissions = [
        ...selected.account.map(id => ({ resource_type: 'account', resource_id: id })),
        ...selected.fanpage.map(id => ({ resource_type: 'fanpage', resource_id: id })),
        ...selected.group.map(id => ({ resource_type: 'group', resource_id: id })),
      ]
      await api.put(`/permissions/${userId}`, { permissions })
      toast.success('Đã lưu phân quyền')
      onClose()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Lỗi lưu phân quyền')
    } finally {
      setSaving(false)
    }
  }

  const accounts = resources?.accounts || []
  const fanpages = resources?.fanpages || []
  const groups = resources?.groups || []

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-app-surface rounded p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-1">Phân quyền: {userName}</h2>
        <p className="text-sm text-app-muted mb-4">Chọn tài khoản, fanpage, nhóm mà user được phép sử dụng.</p>

        {loading ? (
          <div className="flex justify-center py-8"><div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" /></div>
        ) : (
          <div className="space-y-5">
            {/* Accounts */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-app-primary">Tài khoản Facebook ({selected.account.length}/{accounts.length})</h3>
                <button onClick={() => selectAll('account', accounts.map(a => a.id))} className="text-xs text-info hover:underline">
                  {selected.account.length === accounts.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {accounts.map(a => (
                  <label key={a.id} className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer text-sm ${selected.account.includes(a.id) ? 'border-blue-400 bg-blue-50' : 'border-app-border hover:bg-app-base'}`}>
                    <input type="checkbox" checked={selected.account.includes(a.id)} onChange={() => toggle('account', a.id)} className="w-3.5 h-3.5 rounded" />
                    <span className="truncate">{a.username || a.fb_user_id}</span>
                  </label>
                ))}
                {accounts.length === 0 && <p className="text-xs text-app-dim col-span-2">Chưa có tài khoản nào</p>}
              </div>
            </div>

            {/* Fanpages */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-app-primary">Fanpage ({selected.fanpage.length}/{fanpages.length})</h3>
                <button onClick={() => selectAll('fanpage', fanpages.map(f => f.id))} className="text-xs text-info hover:underline">
                  {selected.fanpage.length === fanpages.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {fanpages.map(f => (
                  <label key={f.id} className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer text-sm ${selected.fanpage.includes(f.id) ? 'border-green-400 bg-green-50' : 'border-app-border hover:bg-app-base'}`}>
                    <input type="checkbox" checked={selected.fanpage.includes(f.id)} onChange={() => toggle('fanpage', f.id)} className="w-3.5 h-3.5 rounded" />
                    <span className="truncate">{f.name || f.fb_page_id}</span>
                  </label>
                ))}
                {fanpages.length === 0 && <p className="text-xs text-app-dim col-span-2">Chưa có fanpage nào</p>}
              </div>
            </div>

            {/* Groups */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-app-primary">Nhóm ({selected.group.length}/{groups.length})</h3>
                <button onClick={() => selectAll('group', groups.map(g => g.id))} className="text-xs text-info hover:underline">
                  {selected.group.length === groups.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                {groups.map(g => (
                  <label key={g.id} className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer text-sm ${selected.group.includes(g.id) ? 'border-orange-400 bg-orange-50' : 'border-app-border hover:bg-app-base'}`}>
                    <input type="checkbox" checked={selected.group.includes(g.id)} onChange={() => toggle('group', g.id)} className="w-3.5 h-3.5 rounded" />
                    <span className="truncate">{g.name || g.fb_group_id}</span>
                  </label>
                ))}
                {groups.length === 0 && <p className="text-xs text-app-dim col-span-2">Chưa có nhóm nào</p>}
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-between items-center mt-6 pt-4 border-t">
          <p className="text-xs text-app-dim">
            Tổng: {selected.account.length + selected.fanpage.length + selected.group.length} quyền
          </p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 border rounded-lg hover:bg-app-base">Hủy</button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
            >
              {saving ? 'Đang lưu...' : 'Lưu phân quyền'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
