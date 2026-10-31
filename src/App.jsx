import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileText,
  History,
  LayoutDashboard,
  LogOut,
  Mail,
  MessageSquareText,
  Menu,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Upload,
  Users,
  X,
  XCircle
} from 'lucide-react';


import { supabase, supabaseConfigured } from './supabase';

import { Capacitor } from '@capacitor/core';
import { FirebaseMessaging } from '@capacitor-firebase/messaging';


const REMINDER_DAYS = [60, 45, 30, 21, 14, 10, 7, 3, 2, 1, 0];

const todayISO = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const dayDiff = (date) => date ? Math.ceil((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86400000) : null;
const dateLabel = (date) => date ? new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not set';
const timestampLabel = (value) =>
  value
    ? new Date(value).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
    : 'Time unavailable';

const statusDisplay = (status, reason) => {
  if (status === 'action_required') {
    if (reason === 'update_dates') {
      return {
        label: 'Action required — Update your FRRO new dates',
        tone: 'danger',
      };
    }

    if (reason === 'upload_correct_document') {
      return {
        label: 'Action required — Upload correct FRRO document',
        tone: 'danger',
      };
    }

    return {
      label: 'Action required — Update your FRRO new dates',
      tone: 'danger',
    };
  }

  const statuses = {
    in_progress: {
      label: 'Submitted-under process',
      tone: 'warning',
    },
    received: {
      label: 'New FRRO received',
      tone: 'success',
    },
    document_approved: {
      label: 'Uploaded FRRO document approved',
      tone: 'success',
    },
    document_rejected: {
      label: 'Uploaded FRRO document rejected',
      tone: 'danger',
    },
    rejected: {
      label: 'Rejected',
      tone: 'danger',
    },
  };

  return statuses[status] || {
    label: status || 'Status not set',
    tone: 'neutral',
  };
};


function statusFor(date) {
  const days = dayDiff(date);

  if (days === null) {
    return { label: 'Date missing', tone: 'muted' };
  }

  if (days < 0) {
    return { label: 'Expired', tone: 'danger' };
  }

  if (days < 60) {
    return {
      label: 'Urgent renewal application required',
      tone: days <= 14 ? 'danger' : 'warning'
    };
  }

  return { label: 'On track', tone: 'success' };
}

function renewalStatusFor(frro) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!frro?.next_expiry_date) {
    return {
      label: 'Dates missing',
      tone: 'neutral',
      key: 'missing'
    };
  }

  const expiryDate = new Date(`${frro.next_expiry_date}T00:00:00`);
  const daysRemaining = Math.round(
    (expiryDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)
  );


  // Keep "New FRRO received" visible for seven days
  // after the administrator confirms receipt.
  const receivedAt = frro?.renewal_received_at
    ? new Date(frro.renewal_received_at).getTime()
    : null;

  const receivedForSevenDays =
    frro?.renewal_status === 'received' &&
    receivedAt !== null &&
    Number.isFinite(receivedAt) &&
    Date.now() - receivedAt >= 0 &&
    Date.now() - receivedAt < 7 * 24 * 60 * 60 * 1000;

  if (receivedForSevenDays) {
    return {
      label: 'New FRRO received',
      tone: 'success',
      key: 'received'
    };
  }


  // An expired FRRO takes priority after the seven-day period.
  if (daysRemaining < 0) {
    return {
      label: 'Expired',
      tone: 'danger',
      key: 'expired'
    };
  }

  // If a renewal application is underway, preserve that status.
  if (frro.renewal_status === 'in_progress') {
    return {
      label: 'Submitted-under process',
      tone: 'warning',
      key: 'in_progress'
    };
  }

  // Within 60 days of expiry, the student needs to act.
  if (daysRemaining <= 60) {
    return {
      label: 'Urgent — not applied',
      tone: 'warning',
      key: 'urgent'
    };
  }

  return {
    label: 'FRRO is valid',
    tone: 'success',
    key: 'valid'
  };
}



function Stat({ label, value, icon, hint, tone = 'success' }) {
  return (
    <div className={`stat-card ${tone}`}>
      <div className="stat-icon">{icon}</div>
      <div className="stat-content">
        <span className="stat-label">{label}</span>
        <strong className="stat-value">{value}</strong>
        <span className="stat-hint">{hint}</span>
      </div>
    </div>
  );
}

function Notice({ notice, clear }) {
  if (!notice) return null;
  return <div className={`notice ${notice.type}`} role="status">
    {notice.type === 'error' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
    <span>{notice.text}</span><button className="icon-button" onClick={clear} aria-label="Dismiss"><XCircle size={17} /></button>
  </div>;
}

export default function App() {
  const [showPassword, setShowPassword] = useState(false);
  const [session, setSession] = useState(null);
  const [frroDocuments, setFrroDocuments] = useState([]);
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [profile, setProfile] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const [record, setRecord] = useState({
    frro_issue_date: '',
    next_expiry_date: '',
    renewal_status: 'not_applied',
    application_applied_at: null,
    renewal_received_at: null
  });

  const [, setStatusRefreshTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setStatusRefreshTick((tick) => tick + 1);
    }, 60 * 1000); // Check every 60 seconds

    return () => clearInterval(timer);
  }, []);



  const [studentDetails, setStudentDetails] = useState({
    full_name: '',
    roll_no: '',
    course: '',
    country: ''
  });
  const [students, setStudents] = useState([]);
  const [renewalHistory, setRenewalHistory] = useState([]);
  const [statusHistory, setStatusHistory] = useState([]);
  const [loadingStatusHistory, setLoadingStatusHistory] = useState(false);

  const [adminDocuments, setAdminDocuments] = useState([]);
  const [loadingAdminDocuments, setLoadingAdminDocuments] = useState(false);

  const [notifications, setNotifications] = useState([]);
  const [mode, setMode] = useState('login');
  const [passwordResetMode, setPasswordResetMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingDates, setEditingDates] = useState(false);
  const [notice, setNotice] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedStudents, setSelectedStudents] = useState([]);
  const [messageTitle, setMessageTitle] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [messageChannel, setMessageChannel] = useState('in_app');
  const [emailRequestId, setEmailRequestId] = useState(null);
  const [tab, setTab] = useState('renewals');
  const [studentSection, setStudentSection] = useState('dashboard');

  const flash = useCallback((text, type = 'success') => {
    setNotice({ text, type });
  }, []);
  const loadStatusHistory = useCallback(async () => {
    if (!supabase || !session?.user?.id) return;

    setLoadingStatusHistory(true);

    try {
      let query = supabase
        .from('frro_status_history')
        .select(
          'id,user_id,status,reason,changed_by,changed_at,notification_expires_at'
        )
        .order('changed_at', { ascending: false })
        .limit(200);

      // Students can see only their own history.
      // Verified admins can see the history permitted by the RLS policy.
      if (
        profile?.role !== 'admin' ||
        profile?.verification_status !== 'verified'
      ) {
        query = query.eq('user_id', session.user.id);
      }

      const { data, error } = await query;

      if (error) throw error;

      const rows = data ?? [];
      const userIds = [...new Set(rows.map(row => row.user_id))];

      let profileMap = new Map();

      if (userIds.length) {
        const { data: people, error: peopleError } = await supabase
          .from('student_profiles')
          .select('user_id,full_name,email,roll_no')
          .in('user_id', userIds);

        if (peopleError) throw peopleError;

        profileMap = new Map(
          (people ?? []).map(person => [person.user_id, person])
        );
      }

      setStatusHistory(
        rows.map(row => ({
          ...row,
          student: profileMap.get(row.user_id) ?? null,
        }))
      );
    } catch (error) {
      flash(`Could not load status history: ${error.message}`, 'error');
    } finally {
      setLoadingStatusHistory(false);
    }
  }, [
    session?.user?.id,
    profile?.role,
    profile?.verification_status,
  ]);

  async function saveStatusChange(userId, status, reason = null) {
    if (!supabase || !session?.user?.id || !userId) {
      throw new Error('Your session or student ID is missing.');
    }

    const sentAt = new Date();
    const expiresAt = new Date(
      sentAt.getTime() + 7 * 24 * 60 * 60 * 1000
    );

    const { error } = await supabase
      .from('frro_status_history')
      .insert({
        user_id: userId,
        status,
        reason,
        changed_by: session.user.id,
        notification_sent_at: sentAt.toISOString(),
        notification_expires_at: expiresAt.toISOString(),
      });

    if (error) throw error;
  }

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data, error }) => {
      if (error) flash(error.message, 'error');
      setSession(data?.session ?? null);
    });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, next) => {
        setSession(next);

        if (event === 'PASSWORD_RECOVERY') {
          setPasswordResetMode(true);
          setNotice(null);
        }
      }
    );

    return () => listener.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!supabase || !session?.user || !Capacitor.isNativePlatform()) {
      return;
    }

    let tokenListener;
    let cancelled = false;

    const saveToken = async token => {
      if (!token || cancelled) return;

      const { error } = await supabase
        .from('push_device_tokens')
        .upsert(
          {
            user_id: session.user.id,
            token,
            platform: Capacitor.getPlatform(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'token' }
        );

      if (error) {
        console.error('Saving FCM token failed:', error.message);
      } else {
        console.log('FCM token saved to Supabase.');
      }
    };

    const registerForPush = async () => {
      try {
        const permission = await FirebaseMessaging.requestPermissions();

        if (permission.receive !== 'granted') {
          console.warn('Push notification permission not granted.');
          return;
        }

        tokenListener = await FirebaseMessaging.addListener(
          'tokenReceived',
          event => {
            saveToken(event.token).catch(error =>
              console.error('Saving FCM token failed:', error)
            );
          }
        );

        const result = await FirebaseMessaging.getToken();

        if (result?.token) {
          await saveToken(result.token);
        } else {
          console.warn('Firebase Messaging returned no token.');
        }
      } catch (error) {
        console.error('Firebase Messaging setup failed:', error);
      }
    };

    registerForPush();

    return () => {
      cancelled = true;
      tokenListener?.remove();
    };
  }, [session?.user?.id]);
  const loadProfileAndData = useCallback(async () => {
    if (!supabase || !session?.user) return;

    setLoading(true);

    try {
      const { data: p, error: pe } = await supabase
        .from('student_profiles')
        .select(
          'user_id,full_name,email,role,verification_status,created_at,roll_no,course,country'
        )
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (pe) throw pe;

      setProfile(p ?? null);

      setStudentDetails({
        full_name: p?.full_name ?? '',
        roll_no: p?.roll_no ?? '',
        course: p?.course ?? '',
        country: p?.country ?? '',
      });

      const { data: r, error: re } = await supabase
        .from('frro_records')
        .select(
          'id,user_id,frro_issue_date,next_expiry_date,renewal_status,application_applied_at,renewal_received_at,updated_at'
        )

        .eq('user_id', session.user.id)
        .maybeSingle();

      if (re) throw re;


      setRecord({
        frro_issue_date: r?.frro_issue_date ?? '',
        next_expiry_date: r?.next_expiry_date ?? '',
        renewal_status: r?.renewal_status ?? 'not_applied',
        application_applied_at: r?.application_applied_at ?? null,
        renewal_received_at: r?.renewal_received_at ?? null,
      });


      const { data: n, error: ne } = await supabase
        .from('in_app_notifications')
        .select('id,title,body,created_at,read_at')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false })
        .limit(30);

      if (ne) throw ne;

      setNotifications(n ?? []);
    } catch (e) {
      flash(e.message || 'Could not load your account.', 'error');
    } finally {
      setLoading(false);
    }
  }, [session?.user?.id]);

  const loadFrroDocuments = useCallback(async () => {
    if (!supabase || !session?.user?.id) return;

    const { data, error } = await supabase
      .from('frro_documents')
      .select(
        'id, storage_path, drive_file_id, original_file_name, content_type, file_size, uploaded_at, review_status, review_reason, reviewed_at'
      )
      .eq('user_id', session.user.id)
      .order('uploaded_at', { ascending: false });

    if (error) {
      flash(`Could not load FRRO documents: ${error.message}`, 'error');
      return;
    }

    setFrroDocuments(data ?? []);
  }, [session?.user?.id, flash]);



  const viewFrroDocument = async (file) => {
    if (!supabase || !file?.id) {
      flash('Document or Supabase session is unavailable.', 'error');
      return;
    }

    const newTab = window.open('about:blank', '_blank');

    if (!newTab) {
      flash('Please allow pop-ups to view this document.', 'error');
      return;
    }

    try {
      newTab.document.title = 'Loading document…';

      const {
        data: { session: currentSession },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !currentSession?.access_token) {
        throw new Error('Your session has expired. Please sign in again.');
      }

      let blob;

      if (file.storage_path) {
        // Download from the private Supabase Storage bucket.
        const { data, error } = await supabase.storage
          .from('FRRO Document')
          .download(file.storage_path);

        if (error) throw error;
        if (!data) throw new Error('The document file was not found.');

        blob = data;
      } else if (file.drive_file_id) {
        // Keep legacy Google Drive documents accessible.
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/view-google-drive-document`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${currentSession.access_token}`,
              apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ fileId: file.drive_file_id }),
          }
        );

        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(
            result.error || 'Unable to open the Google Drive document.'
          );
        }

        blob = await response.blob();
      } else {
        throw new Error('This document has no valid storage location.');
      }

      const objectUrl = URL.createObjectURL(blob);

      newTab.location.href = objectUrl;
      newTab.document.title =
        file.original_file_name || 'FRRO Document';

      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 5 * 60 * 1000);
    } catch (error) {
      newTab.close();
      flash(error.message || 'Unable to open this document.', 'error');
    }
  };

  const handleUpdatePassword = async (event) => {
    event.preventDefault();

    if (!supabase) {
      flash('Supabase is not configured.', 'error');
      return;
    }

    const form = event.currentTarget;

    // Step 1: Send password reset email
    if (mode === 'forgot-password') {
      const email = form.elements.email.value.trim();

      if (!email) {
        flash('Please enter your email address.', 'error');
        return;
      }

      setSaving(true);

      try {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/`,
        });

        if (error) throw error;

        flash(
          'If an account exists for that email, a password reset link will be sent.',
          'success'
        );
      } catch (error) {
        flash(
          error.message || 'Unable to send the reset link.',
          'error'
        );
      } finally {
        setSaving(false);
      }

      return;
    }

    // Step 2: Validate the new password
    const password = form.elements.newPassword.value;

    if (password.length < 8) {
      flash('Password must be at least 8 characters.', 'error');
      return;
    }

    setSaving(true);

    try {
      // Step 3: Update password using the recovery session
      const { error } = await supabase.auth.updateUser({
        password,
      });

      if (error) throw error;

      // Step 4: Return to login
      setPasswordResetMode(false);
      setMode('login');

      const { error: signOutError } = await supabase.auth.signOut();

      if (signOutError) {
        console.error('Sign-out after password update:', signOutError);
      }

      flash(
        'Password updated successfully. Please sign in with your new password.',
        'success'
      );
    } catch (error) {
      console.error('Password update failed:', error);

      flash(
        error.message || 'Unable to update your password.',
        'error'
      );
    } finally {
      setSaving(false);
    }
  };



  useEffect(() => { loadProfileAndData(); }, [loadProfileAndData]);
  useEffect(() => {
    loadStatusHistory();
  }, [loadStatusHistory]);

  useEffect(() => {
    loadFrroDocuments();
  }, [loadFrroDocuments]);


  const loadStudents = useCallback(async () => {
    if (!supabase || profile?.role !== 'admin') return;
    setLoading(true);
    try {
      const { data: people, error: pe } = await supabase.from('student_profiles')
        .select('user_id,full_name,email,role,verification_status,created_at,roll_no,course,country')
        .eq('role', 'student').order('full_name');
      if (pe) throw pe;
      const { data: records, error: re } = await supabase
        .from('frro_records')
        .select(`
  user_id,
  frro_issue_date,
  next_expiry_date,
  renewal_status,
  application_applied_at,
  renewal_received_at
`);
      if (re) throw re;
      const recordMap = new Map((records ?? []).map(r => [r.user_id, r]));
      setStudents((people ?? []).map(p => ({ ...p, frro: recordMap.get(p.user_id) ?? null })));
    } catch (e) {
      flash(`Could not load student list: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [profile?.role]);

  const loadRenewalHistory = useCallback(async () => {
    if (!supabase || profile?.role !== 'admin') return;

    try {
      const { data, error } = await supabase
        .from('frro_renewal_history')
        .select(`
        id,
        user_id,
        new_renewal_date,
        new_expiry_date,
        changed_at
      `)
        .order('changed_at', { ascending: false })
        .limit(200);

      if (error) throw error;

      const historyRows = data ?? [];
      const userIds = [
        ...new Set(historyRows.map((row) => row.user_id))
      ];

      let profileMap = new Map();

      if (userIds.length > 0) {
        const { data: people, error: peopleError } = await supabase
          .from('student_profiles')
          .select('user_id, full_name, email')
          .in('user_id', userIds);

        if (peopleError) throw peopleError;

        profileMap = new Map(
          (people ?? []).map((person) => [
            person.user_id,
            person
          ])
        );
      }

      setRenewalHistory(
        historyRows.map((row) => ({
          ...row,
          student: profileMap.get(row.user_id) ?? null
        }))
      );
    } catch (e) {
      flash(
        `Could not load renewal history: ${e.message}`,
        'error'
      );
    }
  }, [profile?.role]);

  const loadAdminDocuments = useCallback(async () => {
    if (!supabase || profile?.role !== 'admin' ||
      profile?.verification_status !== 'verified') {
      return;
    }

    setLoadingAdminDocuments(true);

    try {
      const { data: documents, error } = await supabase
        .from('frro_documents')
        .select(
          'id, user_id, drive_file_id, storage_path, original_file_name, content_type, file_size, uploaded_at, review_status, review_reason, reviewed_by, reviewed_at'
        )
        .order('uploaded_at', { ascending: false });

      if (error) throw error;

      const userIds = [
        ...new Set((documents ?? []).map((doc) => doc.user_id))
      ];

      let profileMap = new Map();

      if (userIds.length > 0) {
        const { data: people, error: peopleError } = await supabase
          .from('student_profiles')
          .select('user_id, full_name, email, roll_no, course')
          .in('user_id', userIds);

        if (peopleError) throw peopleError;

        profileMap = new Map(
          (people ?? []).map((person) => [person.user_id, person])
        );
      }

      let frroRecords = [];

      if (userIds.length > 0) {
        const { data, error: frroError } = await supabase
          .from('frro_records')
          .select(`
      user_id,
      frro_issue_date,
      next_expiry_date,
      renewal_status,
      application_applied_at,
      renewal_received_at
    `)
          .in('user_id', userIds);

        if (frroError) throw frroError;

        frroRecords = data ?? [];
      }

      const frroMap = new Map(
        frroRecords.map(frro => [frro.user_id, frro])
      );

      setAdminDocuments(
        (documents ?? []).map((doc) => ({
          ...doc,
          student: profileMap.get(doc.user_id) ?? null,
          frro: frroMap.get(doc.user_id) ?? null
        }))
      );
    } catch (error) {
      flash(`Could not load FRRO documents: ${error.message}`, 'error');
    } finally {
      setLoadingAdminDocuments(false);
    }
  }, [profile?.role, profile?.verification_status]);



  async function openAdminDocument(doc) {
    if (
      !supabase ||
      profile?.role !== 'admin' ||
      profile?.verification_status !== 'verified'
    ) {
      return flash(
        'Only verified administrators can open these documents.',
        'error'
      );
    }

    if (!doc?.id || (!doc.storage_path && !doc.drive_file_id)) {
      return flash(
        'This document has no valid storage location.',
        'error'
      );
    }

    await viewFrroDocument(doc);
  }




  async function confirmNewFrroReceived(student) {
    if (!supabase || !session?.user || !isAdmin) {
      return flash(
        'Only a verified administrator can confirm receipt.',
        'error'
      );
    }

    if (!student?.user_id) {
      return flash('Student user ID is missing.', 'error');
    }

    const confirmedAt = new Date().toISOString();

    setSaving(true);

    try {
      const { error } = await supabase
        .from('frro_records')
        .update({
          renewal_status: 'received',
          renewal_received_at: confirmedAt
        })
        .eq('user_id', student.user_id);

      if (error) throw error;

      await saveStatusChange(
        student.user_id,
        'received'
      );

      flash(
        'New FRRO receipt confirmed. The status will show for 7 days.'
      );

      await loadStatusHistory();
      await loadStudents();
      await loadAdminDocuments();
    } catch (e) {
      flash(
        e.message || 'Could not confirm the new FRRO.',
        'error'
      );
    } finally {
      setSaving(false);
    }
  }


  async function setAdminStudentStatus(student, status, reason = null) {
    if (
      !supabase ||
      !session?.user ||
      !isAdmin
    ) {
      return flash(
        'Only a verified administrator can change student status.',
        'error'
      );
    }

    if (!student?.user_id) {
      return flash('Student user ID is missing.', 'error');
    }

    setSaving(true);

    try {
      await saveStatusChange(
        student.user_id,
        status,
        reason
      );

      flash('Student status updated successfully.');

      await loadStatusHistory();
      await loadStudents();
      await loadAdminDocuments();
    } catch (error) {
      flash(
        error.message || 'Could not update student status.',
        'error'
      );
    } finally {
      setSaving(false);
    }
  }

  async function reviewFrroDocument(doc, reviewStatus, reason = null) {
    if (!supabase || !session?.user || !isAdmin) {
      return flash(
        'Only a verified administrator can review documents.',
        'error'
      );
    }

    if (!doc?.id) {
      return flash('Document ID is missing.', 'error');
    }

    const allowedStatuses = [
      'approved',
      'rejected',
      'action_required',
    ];

    if (!allowedStatuses.includes(reviewStatus)) {
      return flash('Invalid document review status.', 'error');
    }

    setSaving(true);

    try {
      const { error } = await supabase
        .from('frro_documents')
        .update({
          review_status: reviewStatus,
          review_reason: reason,
          reviewed_by: session.user.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', doc.id);

      if (error) throw error;

      // Record the document review in the student's status history.
      const historyStatus = {
        approved: 'document_approved',
        rejected: 'document_rejected',
        action_required: 'action_required',
      }[reviewStatus];

      await saveStatusChange(
        doc.user_id,
        historyStatus,
        reviewStatus === 'action_required'
          ? 'upload_correct_document'
          : reason
      );

      flash('Document review status saved successfully.');

      await loadStatusHistory();
      await loadAdminDocuments();
    } catch (error) {
      flash(error.message || 'Could not save document review.', 'error');
    } finally {
      setSaving(false);
    }
  }


  useEffect(() => { loadStudents(); }, [loadStudents]);

  useEffect(() => {
    loadRenewalHistory();
  }, [loadRenewalHistory]);

  useEffect(() => {
    loadAdminDocuments();
  }, [loadAdminDocuments]);




  async function handleAuth(event) {
    event.preventDefault();

    if (!supabase) {
      return flash(
        'Add your Supabase URL and anon/publishable key to .env.local first.',
        'error'
      );
    }

    setSaving(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim().toLowerCase();
    const password = String(form.get('password') || '');
    const fullName = String(form.get('full_name') || '').trim();
    const rollNo = String(form.get('roll_no') || '').trim();
    const course = String(form.get('course') || '').trim();
    const country = String(form.get('country') || '').trim();
    try {
      if (mode === 'register') {
        if (fullName.length < 2) {
          throw new Error('Enter your full name.');
        }
        if (!rollNo || !course || !country) {
          throw new Error('Please complete your Roll No, Course, and Country.');
        }

        if (!email || !email.includes('@')) {
          throw new Error('Enter a valid email address.');
        }

        if (password.length < 8) {
          throw new Error('Password must be at least 8 characters.');
        }

        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName,
              roll_no: rollNo,
              course: course,
              country: country
            }
          }
        });

        if (error) {
          const message = error.message.toLowerCase();

          if (
            message.includes('already registered') ||
            message.includes('already exists') ||
            message.includes('user already')
          ) {
            throw new Error(
              'This email is already registered. Please log in instead.'
            );
          }

          throw error;
        }

        if (data?.user && data.user.identities?.length === 0) {
          throw new Error(
            'This email is already registered. Please log in instead.'
          );
        }


        flash(
          'Registration submitted. Sign in using your email and password.'
        );

        setMode('login');
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password
        });

        if (error) {
          console.error('Supabase login error:', error.message);
          throw error;
        }
      }
    } catch (e) {
      console.error('Authentication error:', e.message);
      flash(e.message || 'Authentication failed.', 'error');
    } finally {
      setSaving(false);
    }
  }
  async function handleForgotPassword(event) {
    event.preventDefault();

    if (!supabase) {
      return flash('Supabase is not configured.', 'error');
    }

    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim().toLowerCase();

    if (!email || !email.includes('@')) {
      return flash('Enter a valid email address.', 'error');
    }

    setSaving(true);

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/`
      });

      if (error) throw error;

      flash(
        'If an account exists for that email, a password reset link will be sent.'
      );
    } catch (error) {
      flash(error.message || 'Unable to request a password reset.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleNewPassword(event) {
    event.preventDefault();

    if (!supabase) return;

    const form = new FormData(event.currentTarget);
    const password = String(form.get('new_password') || '');
    const confirmation = String(form.get('confirm_password') || '');

    if (password.length < 8) {
      return flash('Password must be at least 8 characters.', 'error');
    }

    if (password !== confirmation) {
      return flash('The passwords do not match.', 'error');
    }

    setSaving(true);

    try {
      const { error } = await supabase.auth.updateUser({ password });

      if (error) throw error;

      setPasswordResetMode(false);
      setSession(null);
      await supabase.auth.signOut();
      setMode('login');

      flash('Password updated successfully. Please sign in with your new password.');
    } catch (error) {
      flash(error.message || 'Unable to update your password.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function markSubmittedUnderProcess() {
    if (!supabase || !session?.user) return;

    if (!record.next_expiry_date) {
      return flash(
        'Please save your FRRO dates before marking your application as submitted.',
        'error'
      );
    }

    if (record.renewal_status === 'in_progress') {
      return flash('Your renewal application is already marked as in progress.');
    }

    setSaving(true);

    try {
      const submittedAt =
        record.application_applied_at || new Date().toISOString();

      const { error } = await supabase
        .from('frro_records')
        .update({
          renewal_status: 'in_progress',
          application_applied_at: submittedAt
        })
        .eq('user_id', session.user.id);

      if (error) throw error;

      // Record the status change and its timestamp in the history table.
      await saveStatusChange(
        session.user.id,
        'in_progress'
      );

      setRecord(prev => ({
        ...prev,
        renewal_status: 'in_progress',
        application_applied_at: submittedAt
      }));

      // Refresh status history for the student and admin views.
      await loadStatusHistory();

      flash(
        'Application submission recorded. Student services can now see your status.'
      );

      await loadProfileAndData();
      await loadStudents();
    } catch (e) {
      flash(e.message || 'Could not update your renewal status.', 'error');
    } finally {
      setSaving(false);
    }
  }



  async function saveDates(event) {
    event.preventDefault();

    if (!supabase || !session?.user) return;

    if (
      !studentDetails.full_name.trim() ||
      !studentDetails.roll_no.trim() ||
      !studentDetails.course.trim() ||
      !studentDetails.country.trim()
    ) {
      return flash('Please complete all student details.', 'error');
    }

    if (!record.frro_issue_date || !record.next_expiry_date) {
      return flash('Enter the FRRO issue date and expiry date.', 'error');
    }

    if (record.frro_issue_date > record.next_expiry_date) {
      return flash('Issue date cannot be after expiry date.', 'error');
    }



    setSaving(true);

    try {
      const { error: profileError } = await supabase
        .from('student_profiles')
        .update({
          full_name: studentDetails.full_name.trim(),
          roll_no: studentDetails.roll_no.trim(),
          course: studentDetails.course.trim(),
          country: studentDetails.country.trim()
        })
        .eq('user_id', session.user.id);

      if (profileError) throw profileError;


      const { error: recordError } = await supabase
        .from('frro_records')
        .upsert({
          user_id: session.user.id,
          frro_issue_date: record.frro_issue_date,
          next_expiry_date: record.next_expiry_date,
          renewal_status: record.renewal_status || 'not_applied',
          application_applied_at: record.application_applied_at ?? null,
          renewal_received_at: record.renewal_received_at ?? null
        }, { onConflict: 'user_id' });

      if (recordError) throw recordError;

      setEditingDates(false);
      flash('Student details and FRRO dates saved successfully.');

      await loadProfileAndData();
      await loadStudents();
    } catch (e) {
      flash(e.message || 'Could not save your details.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function sendAnnouncement(event) {
    event.preventDefault();

    if (!supabase || profile?.role !== 'admin') return;

    if (!messageTitle.trim() || !messageBody.trim()) {
      return flash('Enter a message title and message.', 'error');
    }

    if (selectedStudents.length === 0) {
      return flash('Select at least one student before sending.', 'error');
    }

    setSending(true);

    const title = messageTitle.trim();
    const body = messageBody.trim();

    try {
      const recipients = students
        .filter(s => selectedStudents.includes(s.user_id))
        .map(s => ({
          user_id: s.user_id,
          title,
          body
        }));

      if (!recipients.length) {
        throw new Error('No selected student accounts were found.');
      }

      const sendInAppAndPush =
        messageChannel === 'in_app' || messageChannel === 'both';

      const sendEmail =
        messageChannel === 'email' || messageChannel === 'both';

      const results = [];

      // 1. Save in-app notifications.
      if (sendInAppAndPush) {
        try {
          const { error } = await supabase
            .from('in_app_notifications')
            .insert(recipients);

          if (error) throw error;

          results.push(
            `In-app: saved for ${recipients.length} student(s).`
          );
        } catch (error) {
          console.error('In-app announcement error:', error);
          results.push(`In-app: failed — ${error.message}`);
        }

        // 2. Send Firebase device push notifications.
        try {
          const pushResults = await Promise.all(
            recipients.map(async recipient => {
              try {
                const { data, error } = await supabase.functions.invoke(
                  'send-push',
                  {
                    body: {
                      user_id: recipient.user_id,
                      title: recipient.title,
                      message: recipient.body
                    }
                  }
                );

                if (error || data?.error) {
                  return { success: false, sent: 0 };
                }

                return {
                  success: true,
                  sent: data?.sent ?? 0
                };
              } catch (error) {
                console.error('Individual push error:', error);
                return { success: false, sent: 0 };
              }
            })
          );

          const pushSent = pushResults.filter(
            result => result.success && result.sent > 0
          ).length;

          const pushFailed = pushResults.filter(
            result => !result.success
          ).length;

          const noDevice = pushResults.filter(
            result => result.success && result.sent === 0
          ).length;

          results.push(
            `Device push: ${pushSent} accepted, ${noDevice} without a registered device, ${pushFailed} failed.`
          );
        } catch (error) {
          console.error('Push notification error:', error);
          results.push(`Device push: failed — ${error.message}`);
        }
      }

      // 3. Send email announcements.
      if (sendEmail) {
        try {
          const requestId = emailRequestId || crypto.randomUUID();

          if (!emailRequestId) {
            setEmailRequestId(requestId);
          }

          const { data, error } = await supabase.functions.invoke(
            'send-admin-announcement',
            {
              body: {
                request_id: requestId,
                user_ids: recipients.map(recipient => recipient.user_id),
                title,
                body
              }
            }
          );

          if (error) throw error;
          if (data?.error) throw new Error(data.error);

          const emailSent = data?.sent ?? 0;
          const emailFailed = data?.failed ?? 0;
          const emailSkipped = data?.skipped ?? 0;

          results.push(
            `Email: ${emailSent} sent, ${emailFailed} failed, ${emailSkipped} skipped.`
          );

          // Reset the email request ID after a successful response.
          if (emailFailed === 0) {
            setEmailRequestId(null);
          }
        } catch (error) {
          console.error('Email announcement error:', error);
          results.push(`Email: failed — ${error.message}`);
        }
      }

      console.log('Announcement results:', results);

      const hasFailure = results.some(
        result => result.includes('failed')
      );

      flash(
        results.join(' | '),
        hasFailure ? 'error' : 'success'
      );

      // Keep the message and recipients if a channel failed,
      // so you can inspect the result before trying again.
      if (!hasFailure) {
        setMessageTitle('');
        setMessageBody('');
        setSelectedStudents([]);
        setEmailRequestId(null);
      }

    } catch (error) {
      console.error('Announcement error:', error);
      flash(error.message || 'Could not send announcement.', 'error');
    } finally {
      setSending(false);
    }
  }

  async function markRead(id) {
    const { error } = await supabase.from('in_app_notifications').update({ read_at: new Date().toISOString() }).eq('id', id);
    if (error) flash(error.message, 'error');
    else setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
  }


  async function signOut() {
    await supabase?.auth.signOut();
    setProfile(null);
    setStudents([]);
    setFrroDocuments([]);
    setSelectedDocument(null);

    setRecord({
      frro_issue_date: '',
      next_expiry_date: '',
      renewal_status: 'not_applied',
      application_applied_at: null,
      renewal_received_at: null
    });

  }




  const filteredStudents = useMemo(() => students.filter(s => {
    const q = search.trim().toLowerCase();
    const days = dayDiff(s.frro?.next_expiry_date);
    const renewalStatus = renewalStatusFor(s.frro);

    const urgent = renewalStatus.key === 'urgent';
    const expired = renewalStatus.key === 'expired';
    const missing = renewalStatus.key === 'missing';

    const notApplied =
      !s.frro?.renewal_status ||
      s.frro.renewal_status === 'not_applied';

    const searchableText =
      `${s.full_name ?? ''} ${s.email ?? ''} ` +
      `${renewalStatus.label} ${renewalStatus.key} ` +
      `${s.verification_status ?? ''}`.toLowerCase();

    if (!searchableText.includes(q)) return false;

    if (filter === 'due') {
      return days !== null && days >= 0 && days < 60;
    }

    if (filter === 'urgent') return urgent;

    if (filter === 'not_applied') {
      return notApplied && !expired && !missing;
    }

    if (filter === 'in_progress') {
      return renewalStatus.key === 'in_progress';
    }

    if (filter === 'received') {
      return renewalStatus.key === 'received';
    }

    if (filter === 'valid') {
      return renewalStatus.key === 'valid';
    }

    if (filter === 'expired') return expired;
    if (filter === 'missing') return missing;

    if (filter === 'verified') {
      return s.verification_status === 'verified';
    }

    return true;
  }), [students, search, filter]);





  const counts = useMemo(() => {
    const total = students.length;
    let due = 0;
    let urgent = 0;
    let notApplied = 0;
    let inProgress = 0;
    let received = 0;
    let valid = 0;
    let expired = 0;
    let missing = 0;

    students.forEach(s => {
      const status = renewalStatusFor(s.frro);

      if (status.key === 'missing') {
        missing++;
        return;
      }

      if (status.key === 'expired') {
        expired++;
        return;
      }

      const days = dayDiff(s.frro?.next_expiry_date);

      if (days !== null && days >= 0 && days <= 60) {
        due++;
      }

      if (status.key === 'urgent') urgent++;
      if (status.key === 'in_progress') inProgress++;
      if (status.key === 'received') received++;
      if (status.key === 'valid') valid++;

      if (
        (!s.frro?.renewal_status ||
          s.frro.renewal_status === 'not_applied') &&
        status.key !== 'missing'
      ) {
        notApplied++;
      }
    });

    return {
      total,
      due,
      urgent,
      notApplied,
      inProgress,
      received,
      valid,
      expired,
      missing
    };
  }, [students]);


  if (!supabaseConfigured) return <div className="setup-screen"><div className="auth-card setup-card"><div className="brand"><div className="brand-icon">MRU</div><div><strong>MRU FRRO Tracker</strong><span>Student renewal management</span></div></div><div className="setup-symbol"><ShieldCheck size={30} /></div><h1>Connect your Supabase project</h1><p>Create <code>.env.local</code> from <code>.env.example</code>, add your project URL and publishable/anon key, then restart the development server.</p><div className="setup-code">VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co<br />VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_KEY</div><p className="muted">Never put a Supabase service-role key in a browser app.</p></div></div>;
  if (passwordResetMode) {
    return (
      <div className="auth-layout">
        <div className="auth-panel">
          <form className="auth-card" onSubmit={handleNewPassword}>
            <div className="auth-card-head">
              <span className="eyebrow">PASSWORD RECOVERY</span>
              <h2>Set a new password</h2>
              <p>Choose a new password for your account.</p>
            </div>

            <label>
              New password
              <input
                name="new_password"
                type="password"
                minLength={8}
                autoComplete="new-password"
                required
                placeholder="At least 8 characters"
              />
            </label>

            <label>
              Confirm new password
              <input
                name="confirm_password"
                type="password"
                minLength={8}
                autoComplete="new-password"
                required
                placeholder="Enter your new password again"
              />
            </label>

            <button className="primary-button" disabled={saving}>
              {saving ? 'Updating…' : 'Update password'}
            </button>

            <Notice notice={notice} clear={() => setNotice(null)} />
          </form>
        </div>
      </div>
    );
  }

  // Login, registration and forgot-password screens
  if (!session) {
    return (
      <div className="auth-layout auth-layout-compact">
        <div className="auth-panel">
          <form
            className="auth-card"
            onSubmit={mode === 'forgot-password' ? handleForgotPassword : handleAuth}
          >
            <div className="auth-card-head">
              <span className="eyebrow">
                {mode === 'login'
                  ? 'WELCOME BACK'
                  : mode === 'register'
                    ? 'GET STARTED'
                    : 'ACCOUNT RECOVERY'}
              </span>

              <h2>
                {mode === 'login'
                  ? 'Sign in to your account'
                  : mode === 'register'
                    ? 'Create a student account'
                    : 'Reset your password'}
              </h2>

              <p>
                {mode === 'login'
                  ? 'Access your renewal details and reminders.'
                  : mode === 'register'
                    ? 'Register to save your FRRO renewal dates.'
                    : 'Enter your email address to receive a password reset link.'}
              </p>
            </div>

            {mode === 'register' && (
              <>
                <label>
                  Student name
                  <input
                    name="full_name"
                    autoComplete="name"
                    required
                    placeholder="Your full name"
                  />
                </label>

                <label>
                  Roll No
                  <input
                    name="roll_no"
                    required
                    placeholder="Your university roll number"
                  />
                </label>

                <label>
                  Course
                  <input
                    name="course"
                    required
                    placeholder="Your course"
                  />
                </label>

                <label>
                  Country
                  <input
                    name="country"
                    required
                    placeholder="Your country"
                  />
                </label>
              </>
            )}

            <label>
              Email address
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@example.com"
              />
            </label>

            {mode !== 'forgot-password' && (
              <label>
                Password
                <div className="password-input-wrap">
                  <input
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    minLength={8}
                    autoComplete={
                      mode === 'login'
                        ? 'current-password'
                        : 'new-password'
                    }
                    required
                    placeholder="At least 8 characters"
                  />

                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() =>
                      setShowPassword((current) => !current)
                    }
                    aria-label={
                      showPassword ? 'Hide password' : 'Show password'
                    }
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>
            )}

            {mode === 'login' && (
              <p className="forgot-password-link">
                <button
                  type="button"
                  onClick={() => {
                    setMode('forgot-password');
                    setNotice(null);
                  }}
                >
                  Forgot password?
                </button>
              </p>
            )}

            <button
              className="primary-button"
              type="submit"
              disabled={saving}
            >
              {saving
                ? 'Please wait…'
                : mode === 'login'
                  ? 'Sign in'
                  : mode === 'register'
                    ? 'Create account'
                    : 'Send reset link'}

              <ChevronRight size={18} />
            </button>

            <p className="switch-auth">
              {mode === 'login'
                ? 'New student?'
                : mode === 'register'
                  ? 'Already registered?'
                  : 'Remember your password?'}

              {' '}

              <button
                type="button"
                onClick={() => {
                  setMode(mode === 'login' ? 'register' : 'login');
                  setNotice(null);
                }}
              >
                {mode === 'login'
                  ? 'Create an account'
                  : 'Sign in instead'}
              </button>
            </p>

            <Notice
              notice={notice}
              clear={() => setNotice(null)}
            />
          </form>
          <div className="auth-footnote">
            Your FRRO details should be handled only in an approved,
            access-controlled deployment.
          </div>
        </div>
      </div>
    );
  }

  const isAdmin =
    profile?.role === 'admin' &&
    profile?.verification_status === 'verified';

  const myDays = dayDiff(record.next_expiry_date);

  // Navigate to a student section
  const navigateStudentSection = (sectionId) => {
    document.getElementById(sectionId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  };

  const handleDocumentUpload = async (event) => {
    event.preventDefault();

    if (!selectedDocument) {
      setErrorMessage('Please select a document first.');
      return;
    }

    const allowedTypes = [
      'application/pdf',
      'image/jpeg',
      'image/png',
    ];

    if (!allowedTypes.includes(selectedDocument.type)) {
      setErrorMessage('Please select a PDF, JPG, or PNG file.');
      return;
    }

    if (selectedDocument.size > 50 * 1024) {
      setErrorMessage('Document size must not exceed 50 KB.');
      return;
    }

    if (!supabase || !session?.user?.id) {
      setErrorMessage('Please sign in again before uploading.');
      return;
    }

    setUploadingDocument(true);
    setErrorMessage('');
    setNotice(null);

    try {
      const file = selectedDocument;
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = `${session.user.id}/${Date.now()}-${safeName}`;

      // 1. Upload the actual file to Supabase Storage.
      const { data: uploadedFile, error: uploadError } =
        await supabase.storage
          .from('FRRO Document')
          .upload(filePath, file, {
            contentType: file.type,
            upsert: false,
          });

      if (uploadError) throw uploadError;

      // 2. Save the uploaded file's details in the database.
      const { error: insertError } = await supabase
        .from('frro_documents')
        .insert({
          user_id: session.user.id,
          original_file_name: file.name,
          storage_path: uploadedFile.path,
          content_type: file.type,
          file_size: file.size,
        });

      if (insertError) {
        // Remove the uploaded file if saving its metadata fails.
        const { error: cleanupError } = await supabase.storage
          .from('FRRO Document')
          .remove([uploadedFile.path]);

        if (cleanupError) {
          console.error('Storage cleanup failed:', cleanupError.message);
        }

        throw insertError;
      }

      setSelectedDocument(null);

      // Clear the file input.
      if (event.currentTarget) {
        event.currentTarget.reset();
      }

      // Refresh the uploaded document list.
      await loadFrroDocuments();

      flash('FRRO document uploaded successfully.', 'success');
    } catch (error) {
      console.error('FRRO document upload failed:', error);

      setErrorMessage(
        error?.message || 'Document upload failed. Please try again.'
      );

      flash(
        error?.message || 'Document upload failed. Please try again.',
        'error'
      );
    } finally {
      setUploadingDocument(false);
    }
  };

  return (
    <div className="app-frame">
      {/* Hamburger menu button */}
      <button
        type="button"
        className="hamburger-button"
        aria-label="Open navigation menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(true)}
      >
        <Menu size={24} />
      </button>

      {/* Dark overlay when drawer is open */}
      {
        menuOpen && (
          <button
            type="button"
            className="drawer-overlay"
            aria-label="Close navigation menu"
            onClick={() => setMenuOpen(false)}
          />
        )
      }

      <aside
        className={`sidebar navigation-drawer ${menuOpen ? 'drawer-open' : ''
          }`}
      >
        <div className="brand sidebar-brand">
          <div className="brand-icon">MRU</div>
          <div>
            <strong>FRRO Tracker</strong>
            <span>Student services</span>
          </div>
        </div>

        <div className="side-label">WORKSPACE</div>

        {isAdmin ? (
          <>
            <button
              type="button"
              className={`nav-item ${tab === 'renewals' ? 'active' : ''}`}
              onClick={() => setTab('renewals')}
            >
              <Activity size={18} />
              Renewal overview
            </button>

            <button
              type="button"
              className={`nav-item ${tab === 'history' ? 'active' : ''}`}
              onClick={() => setTab('history')}
            >
              <History size={18} />
              Renewal history
            </button>

            <button
              type="button"
              className={`nav-item ${tab === 'documents' ? 'active' : ''}`}
              onClick={() => setTab('documents')}
            >
              <FileText size={18} />
              FRRO Documents
            </button>

            <button
              type="button"
              className={`nav-item ${tab === 'messages' ? 'active' : ''}`}
              onClick={() => setTab('messages')}
            >
              <MessageSquareText size={18} />
              Push messages
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`nav-item ${studentSection === 'dashboard' ? 'active' : ''}`}
              onClick={() => {
                setStudentSection('dashboard');
                setMenuOpen(false);
              }}
            >
              <LayoutDashboard size={18} />
              Dashboard
            </button>

            <button
              type="button"
              className={`nav-item ${studentSection === 'frro-dates' ? 'active' : ''}`}
              onClick={() => setStudentSection('frro-dates')}
            >
              <CalendarDays size={18} />
              My FRRO Dates
            </button>

            <button
              type="button"
              className={`nav-item ${studentSection === 'documents' ? 'active' : ''}`}
              onClick={() => setStudentSection('documents')}
            >
              <FileText size={18} />
              Documents
            </button>

            <button
              type="button"
              className={`nav-item ${studentSection === 'renewal' ? 'active' : ''}`}
              onClick={() => setStudentSection('renewal')}
            >
              <Clock3 size={18} />
              Renewal Application
            </button>

            <button
              type="button"
              className={`nav-item ${studentSection === 'messages' ? 'active' : ''}`}
              onClick={() => setStudentSection('messages')}
            >
              <MessageSquareText size={18} />
              Messages
            </button>

            <button
              type="button"
              className={`nav-item ${studentSection === 'support' ? 'active' : ''}`}
              onClick={() => setStudentSection('support')}
            >
              <Mail size={18} />
              Support
            </button>
          </>
        )}

        <div className="sidebar-bottom">
          <div className="profile-mini">
            <div className="avatar">
              {(profile?.full_name || session.user.email || 'U')
                .slice(0, 1)
                .toUpperCase()}
            </div>

            <div>
              <strong>{profile?.full_name || 'Account'}</strong>
              <span>
                {isAdmin ? 'Administrator' : 'Student account'}
              </span>
            </div>
          </div>

          <button
            type="button"
            className="nav-item signout"
            onClick={signOut}
          >
            <LogOut size={18} />
            Sign out
          </button>
        </div>
      </aside>


      <main className="main-area">
        <header className="page-header">
          <div>
            <span className="eyebrow">
              {isAdmin ? 'ADMINISTRATION' : 'STUDENT PORTAL'}
            </span>
            <h1>
              {isAdmin
                ? 'Renewal overview'
                : `Hello, ${(profile?.full_name || 'there').split(' ')[0]}`}
            </h1>
            <p>
              {isAdmin
                ? 'Monitor expiry dates and keep students informed.'
                : 'Keep your two important FRRO dates up to date.'}
            </p>
          </div>

          <div className="header-actions">
            <span className="live-pill">
              <span />
              Connected
            </span>

            <button
              className="icon-button refresh"
              title="Refresh data"
              onClick={() => {
                loadProfileAndData();
                loadStudents();
                loadRenewalHistory();
              }}
            >
              <RefreshCw size={18} />
            </button>
          </div>
        </header>

        <Notice notice={notice} clear={() => setNotice(null)} />

        {!profile ? (
          <section className="panel empty-state">
            <ShieldCheck size={28} />
            <h2>Profile is being prepared</h2>
            <p>
              If this persists, confirm that the database setup SQL has been
              applied and then sign out and back in.
            </p>
            <button
              className="secondary-button"
              onClick={loadProfileAndData}
            >
              Try again
            </button>
          </section>
        ) : isAdmin ? (
          <>
            <section className="stats-grid">
              <Stat
                label="Total students"
                value={counts.total}
                icon={<Users />}
                hint="Registered student profiles"
              />

              <Stat
                label="Due within 60 days"
                value={counts.due}
                icon={<Clock3 />}
                hint="Renewal action needed"
                tone="warning"
              />

              <Stat
                label="Expired"
                value={counts.expired}
                icon={<AlertCircle />}
                hint="Past the expiry date"
                tone="danger"
              />

              <Stat
                label="Dates missing"
                value={counts.missing}
                icon={<CalendarDays />}
                hint="Follow up with students"
              />

              <Stat
                label="Urgent — not applied"
                value={counts.urgent}
                icon={<AlertCircle />}
                hint="Expiry within 60 days"
                tone="danger"
              />

              <Stat
                label="Applications in progress"
                value={counts.inProgress}
                icon={<Clock3 />}
                hint="Waiting for new FRRO"
                tone="warning"
              />

              <Stat
                label="New FRRO received"
                value={counts.received}
                icon={<CheckCircle2 />}
                hint="Renewed FRRO recorded"
              />

              <Stat
                label="FRRO is valid"
                value={counts.valid}
                icon={<ShieldCheck />}
                hint="More than 60 days remaining"
              />
            </section>

            {tab === 'renewals' ? (
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Student renewal register</h2>
                    <p>
                      All student profiles and their next expiry dates.
                    </p>
                  </div>

                  <button
                    className="secondary-button"
                    onClick={loadStudents}
                  >
                    <RefreshCw size={16} />
                    Refresh
                  </button>
                </div>

                <div className="toolbar">
                  <div className="search-box">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search name, email, or status"
                    />
                  </div>

                  <select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    aria-label="Filter students"
                  >
                    <option value="all">All students</option>
                    <option value="due">Due within 60 days</option>
                    <option value="urgent">Urgent — not applied</option>
                    <option value="not_applied">Not yet applied</option>
                    <option value="in_progress">
                      Submitted-under process
                    </option>
                    <option value="received">New FRRO received</option>
                    <option value="valid">FRRO is valid</option>
                    <option value="expired">Expired students only</option>
                    <option value="missing">Dates missing</option>
                    <option value="verified">Verified profiles</option>
                  </select>
                </div>

                <div className="selection-toolbar">
                  <label>
                    <input
                      type="checkbox"
                      checked={
                        filteredStudents.length > 0 &&
                        filteredStudents.every((s) =>
                          selectedStudents.includes(s.user_id)
                        )
                      }
                      onChange={(e) =>
                        setSelectedStudents((prev) =>
                          e.target.checked
                            ? [
                              ...new Set([
                                ...prev,
                                ...filteredStudents.map((s) => s.user_id),
                              ]),
                            ]
                            : prev.filter(
                              (id) =>
                                !filteredStudents.some(
                                  (s) => s.user_id === id
                                )
                            )
                        )
                      }
                    />
                    Select all students shown ({filteredStudents.length})
                  </label>

                  <span>{selectedStudents.length} selected</span>

                  <button
                    type="button"
                    onClick={() => setTab('messages')}
                    disabled={selectedStudents.length === 0}
                  >
                    Send push message
                  </button>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Select</th>
                        <th>Student name</th>
                        <th>Roll No.</th>
                        <th>Course</th>
                        <th>Country</th>
                        <th>FRRO issue date</th>
                        <th>Expiry date</th>
                        <th>Time left</th>
                        <th>Status</th>
                      </tr>
                    </thead>

                    <tbody>
                      {filteredStudents.map((s) => {
                        const days = dayDiff(s.frro?.next_expiry_date);
                        const latestStatus = statusHistory.find(
                          (item) => item.user_id === s.user_id
                        );

                        const historyStatuses = [
                          'action_required',
                          'document_approved',
                          'document_rejected',
                          'rejected',
                        ];

                        const status =
                          latestStatus && historyStatuses.includes(latestStatus.status)
                            ? statusDisplay(latestStatus.status, latestStatus.reason)
                            : renewalStatusFor(s.frro);

                        return (
                          <tr key={s.user_id}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Select ${s.full_name || s.email}`}
                                checked={selectedStudents.includes(s.user_id)}
                                onChange={(e) =>
                                  setSelectedStudents((prev) =>
                                    e.target.checked
                                      ? [
                                        ...new Set([
                                          ...prev,
                                          s.user_id,
                                        ]),
                                      ]
                                      : prev.filter(
                                        (id) => id !== s.user_id
                                      )
                                  )
                                }
                              />
                            </td>

                            <td>
                              <div className="student-cell">
                                <div className="avatar">
                                  {(s.full_name || s.email || '?')
                                    .slice(0, 1)
                                    .toUpperCase()}
                                </div>
                                <div>
                                  <strong>
                                    {s.full_name || 'Unnamed student'}
                                  </strong>
                                  <span>{s.email}</span>
                                </div>
                              </div>
                            </td>

                            <td>{s.roll_no || 'Not entered'}</td>
                            <td>{s.course || 'Not entered'}</td>
                            <td>{s.country || 'Not entered'}</td>
                            <td>{dateLabel(s.frro?.frro_issue_date)}</td>
                            <td>{dateLabel(s.frro?.next_expiry_date)}</td>

                            <td>
                              {days === null
                                ? '—'
                                : days < 0
                                  ? `${Math.abs(days)} days overdue`
                                  : `${days} days`}
                            </td>

                            <td>
                              <span className={`status-pill ${status.tone}`}>
                                {status.label}
                              </span>
                            </td>
                          </tr>
                        );
                      })}

                      {!filteredStudents.length && (
                        <tr>
                          <td colSpan="9">
                            <div className="table-empty">
                              {loading
                                ? 'Loading student records…'
                                : 'No students match this view yet.'}
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

            ) : tab === 'history' ? (

              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Renewal history</h2>
                    <p>Review changes made to students' FRRO dates.</p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={loadRenewalHistory}
                  >
                    <RefreshCw size={16} /> Refresh
                  </button>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Student</th>
                        <th>New issue date</th>
                        <th>New expiry date</th>
                        <th>Changed at</th>
                      </tr>
                    </thead>
                    <tbody>
                      {renewalHistory.map(item => (
                        <tr key={item.id}>
                          <td>
                            <div className="student-cell">
                              <div className="avatar">
                                {(item.student?.full_name || '?')
                                  .slice(0, 1)
                                  .toUpperCase()}
                              </div>
                              <div>
                                <strong>
                                  {item.student?.full_name || 'Unknown student'}
                                </strong>
                                <span>
                                  {item.student?.email || item.user_id}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td>{dateLabel(item.new_renewal_date)}</td>
                          <td>{dateLabel(item.new_expiry_date)}</td>
                          <td>
                            {item.changed_at
                              ? new Date(item.changed_at).toLocaleString('en-IN')
                              : '—'}
                          </td>
                        </tr>
                      ))}

                      {!renewalHistory.length && (
                        <tr>
                          <td colSpan={4}>
                            <div className="table-empty">
                              No renewal history records found yet.
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="table-footer">
                  <span>Showing {renewalHistory.length} recent changes</span>
                  <span>Latest changes appear first</span>
                </div>
              </section>
            ) : tab === 'documents' ? (
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>FRRO Documents</h2>
                    <p>View documents uploaded by students.</p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={loadAdminDocuments}
                    disabled={loadingAdminDocuments}
                  >
                    <RefreshCw size={16} />
                    {loadingAdminDocuments ? 'Loading…' : 'Refresh'}
                  </button>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Student</th>
                        <th>Roll No.</th>
                        <th>Document</th>
                        <th>File type</th>
                        <th>File size</th>
                        <th>Uploaded</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>

                      {adminDocuments.map(doc => (
                        <tr key={doc.id}>
                          <td>
                            <div className="student-cell">
                              <div className="avatar">
                                {(doc.student?.full_name || '?')
                                  .slice(0, 1)
                                  .toUpperCase()}
                              </div>

                              <div>
                                <strong>
                                  {doc.student?.full_name || 'Unknown student'}
                                </strong>
                                <span>
                                  {doc.student?.email || doc.user_id}
                                </span>
                              </div>
                            </div>
                          </td>

                          <td>{doc.student?.roll_no || 'Not entered'}</td>


                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                              <strong>{doc.original_file_name}</strong>

                              <span
                                className={`status-pill ${doc.review_status === 'approved'
                                  ? 'success'
                                  : doc.review_status === 'rejected' ||
                                    doc.review_status === 'action_required'
                                    ? 'danger'
                                    : 'warning'
                                  }`}
                              >
                                {doc.review_status || 'pending'}
                              </span>

                              {doc.review_reason && (
                                <span className="muted">{doc.review_reason}</span>
                              )}
                            </div>
                          </td>


                          <td>{doc.content_type || 'Unknown'}</td>

                          <td>
                            {doc.file_size != null
                              ? `${Math.round(doc.file_size / 1024)} KB`
                              : '—'}
                          </td>

                          <td>
                            {doc.uploaded_at
                              ? new Date(doc.uploaded_at).toLocaleString('en-IN')
                              : '—'}
                          </td>

                          <td>
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '8px'
                              }}
                            >

                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => openAdminDocument(doc)}
                              >
                                <ExternalLink size={16} />
                                View document
                              </button>

                              <button
                                type="button"
                                className="secondary-button"
                                disabled={saving}
                                onClick={() => reviewFrroDocument(doc, 'approved')}
                              >
                                <CheckCircle2 size={16} />
                                Approve FRRO document
                              </button>

                              <button
                                type="button"
                                className="secondary-button"
                                disabled={saving}
                                onClick={() =>
                                  reviewFrroDocument(
                                    doc,
                                    'rejected',
                                    'Please upload a valid FRRO document.'
                                  )
                                }
                              >
                                <XCircle size={16} />
                                Reject FRRO document
                              </button>

                              <button
                                type="button"
                                className="secondary-button"
                                disabled={saving}
                                onClick={() =>
                                  reviewFrroDocument(
                                    doc,
                                    'action_required',
                                    'Please upload the correct FRRO document.'
                                  )
                                }
                              >
                                Action required: correct document
                              </button>

                              <button
                                type="button"
                                className="secondary-button"
                                disabled={saving}
                                onClick={() =>
                                  setAdminStudentStatus(
                                    { user_id: doc.user_id },
                                    'action_required',
                                    'update_dates'
                                  )
                                }
                              >
                                Action required: update dates
                              </button>

                              <button
                                type="button"
                                className="secondary-button"
                                disabled={saving}
                                onClick={() =>
                                  setAdminStudentStatus(
                                    { user_id: doc.user_id },
                                    'rejected'
                                  )
                                }
                              >
                                <XCircle size={16} />
                                Reject application
                              </button>

                              {doc.review_status === 'approved' &&
                                renewalStatusFor(doc.frro).key !== 'received' && (
                                  <button
                                    type="button"
                                    className="primary-button"
                                    disabled={saving || !doc.frro}
                                    onClick={() =>
                                      confirmNewFrroReceived({
                                        user_id: doc.user_id
                                      })
                                    }
                                  >
                                    {saving
                                      ? 'Confirming…'
                                      : 'Confirm New FRRO Received'}
                                  </button>
                                )}

                              {renewalStatusFor(doc.frro).key === 'received' && (
                                <span className="status-pill success">
                                  Receipt confirmed
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}

                      {!adminDocuments.length && (
                        <tr>
                          <td colSpan={7}>
                            <div className="table-empty">
                              {loadingAdminDocuments
                                ? 'Loading uploaded documents…'
                                : 'No student documents found.'}
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : (
              <section className="panel message-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Announcements</h2>
                    <p>
                      Send announcements through in-app notifications, device push,
                      email, or both.
                    </p>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px'
                    }}
                  >
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setTab('renewals')}
                    >
                      <Users size={16} />
                      Select students
                    </button>

                    <div className="message-icon">
                      <Send size={20} />
                    </div>
                  </div>
                </div>

                <form className="message-form" onSubmit={sendAnnouncement}>
                  <label>
                    Sending method
                    <select
                      value={messageChannel}
                      onChange={e => {
                        setMessageChannel(e.target.value);
                        setEmailRequestId(null);
                      }}
                    >
                      <option value="in_app">
                        In-app + device push
                      </option>
                      <option value="email">
                        Email only
                      </option>
                      <option value="both">
                        Both — in-app, device push and email
                      </option>
                    </select>
                  </label>

                  <label>
                    Message title
                    <input
                      value={messageTitle}
                      onChange={e => setMessageTitle(e.target.value)}
                      maxLength={120}
                      required
                      placeholder="e.g. FRRO renewal reminder"
                    />
                  </label>

                  <label>
                    Message
                    <textarea
                      value={messageBody}
                      onChange={e => setMessageBody(e.target.value)}
                      maxLength={3000}
                      required
                      rows={5}
                      placeholder="Write an announcement for students…"
                    />
                  </label>

                  <div className="form-actions">
                    <span>
                      <Users size={16} />
                      Recipients: {selectedStudents.length} selected students
                    </span>

                    <button
                      type="submit"
                      disabled={sending || selectedStudents.length === 0}
                    >
                      {sending ? 'Sending…' : 'Send announcement'}
                      <Send size={16} />
                    </button>
                  </div>
                </form>
              </section>
            )}
          </>
        ) : (
          <>

            {studentSection === 'dashboard' && (
              <section className="student-welcome" id="student-dashboard">
                <div className="panel-heading">
                  <div>
                    <h2 style={{ color: '#FFFF00' }}>Dashboard</h2>
                    <p style={{ color: '#FFFF00' }}>
                      Welcome to your MRU FRRO Tracker.
                    </p>
                  </div>
                </div>

                <div className="message-icon">
                  <CalendarDays size={20} />
                </div>

                <div className="student-dashboard-grid">
                  <div className="panel student-dashboard-card">
                    <Stat
                      label="Next expiry"
                      value={dateLabel(record.next_expiry_date)}
                      icon={<Clock3 />}
                      hint={
                        myDays === null
                          ? 'Expiry date not set'
                          : myDays < 0
                            ? `${Math.abs(myDays)} days overdue`
                            : `${myDays} days remaining`
                      }
                      tone={
                        myDays !== null && myDays < 0
                          ? 'danger'
                          : myDays !== null && myDays <= 14
                            ? 'danger'
                            : myDays !== null && myDays < 60
                              ? 'warning'
                              : 'success'
                      }
                    />
                  </div>
                </div>
              </section>
            )}

            {studentSection === 'documents' && (
              <section className="panel student-dashboard-card" id="student-documents">
                <div className="panel-heading">
                  <div>
                    <h2>Upload new FRRO document</h2>
                    <p>Upload your renewed FRRO document for your records.</p>
                  </div>
                  <Upload size={22} />
                </div>

                <form onSubmit={handleDocumentUpload}>
                  <label htmlFor="frro-document-file">
                    Select document (PDF, JPG, or PNG; maximum 50 KB)
                  </label>

                  <input
                    id="frro-document-file"
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                    onChange={event =>
                      setSelectedDocument(event.target.files?.[0] ?? null)
                    }
                    disabled={uploadingDocument}
                  />

                  {selectedDocument && (
                    <p className="upload-selected-file">
                      Selected: {selectedDocument.name}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={uploadingDocument || !selectedDocument}
                  >
                    {uploadingDocument
                      ? 'Uploading…'
                      : 'Upload FRRO document'}
                  </button>
                </form>
                {errorMessage && (
                  <p className="error-message" role="alert">
                    {errorMessage}
                  </p>
                )}

                <div className="frro-document-list">
                  <h3>Uploaded documents</h3>

                  {frroDocuments.length === 0 ? (
                    <p>You haven't uploaded any documents yet.</p>
                  ) : (
                    frroDocuments.map(file => (
                      <div className="frro-document-item" key={file.id}>
                        <FileText size={22} />

                        <div className="document-details">
                          <strong>{file.original_file_name}</strong>

                          <small>
                            Uploaded:{' '}
                            {file.uploaded_at
                              ? new Date(file.uploaded_at).toLocaleDateString('en-IN')
                              : 'Date unavailable'}
                          </small>

                          <span
                            className={`status-pill ${file.review_status === 'approved'
                              ? 'success'
                              : ['rejected', 'action_required'].includes(
                                file.review_status
                              )
                                ? 'danger'
                                : 'warning'
                              }`}
                          >
                            {(file.review_status || 'pending').replace('_', ' ')}
                          </span>

                          {file.review_reason && (
                            <p className="document-review-reason">
                              Administrator feedback: {file.review_reason}
                            </p>
                          )}
                        </div>

                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => viewFrroDocument(file)}
                        >
                          View document
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>
            )}

            {studentSection === 'renewal' && (
              <section className="panel student-dashboard-card" id="student-renewal">
                <div className="panel-heading">
                  <div>
                    <h2>FRRO renewal application</h2>
                    <p>Track your application status and status updates.</p>
                  </div>
                </div>

                {(() => {
                  const latestStatus = statusHistory.find(
                    item => item.user_id === session.user.id
                  );

                  const isActionRequired =
                    latestStatus?.status === 'action_required';

                  const expiresAt = latestStatus?.notification_expires_at
                    ? new Date(latestStatus.notification_expires_at).getTime()
                    : null;

                  const notificationIsActive =
                    expiresAt !== null &&
                    Number.isFinite(expiresAt) &&
                    Date.now() < expiresAt;

                  const shouldShowHistoryStatus =
                    latestStatus &&
                    (isActionRequired || notificationIsActive);

                  const currentStatus = shouldShowHistoryStatus
                    ? statusDisplay(latestStatus.status, latestStatus.reason)
                    : renewalStatusFor(record);

                  return (
                    <p>
                      <strong>Status: </strong>
                      <span className={`status-pill ${currentStatus.tone}`}>
                        {currentStatus.label}
                      </span>
                    </p>
                  );
                })()}

                {record.renewal_status !== 'in_progress' &&
                  renewalStatusFor(record).key !== 'received' && (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={markSubmittedUnderProcess}
                      disabled={
                        saving ||
                        !record.next_expiry_date ||
                        myDays === null
                      }
                    >
                      {saving
                        ? 'Updating…'
                        : 'I have submitted my application'}
                    </button>
                  )}

                {record.renewal_status === 'in_progress' && (
                  <p>
                    Your application has been submitted and is being processed.
                    When you receive your new FRRO, upload the renewed document
                    and update the issue and expiry dates under My FRRO Dates.
                  </p>
                )}

                <hr />

                <h3>Status history</h3>

                {loadingStatusHistory ? (
                  <p>Loading status history…</p>
                ) : statusHistory.filter(
                  item => item.user_id === session.user.id
                ).length === 0 ? (
                  <p>No status updates recorded yet.</p>
                ) : (
                  <div className="status-timeline">
                    {statusHistory
                      .filter(item => item.user_id === session.user.id)
                      .map(item => {
                        const display = statusDisplay(
                          item.status,
                          item.reason
                        );

                        return (
                          <div
                            className={`status-timeline-item status-${display.tone}`}
                            key={item.id}
                          >
                            <strong>{display.label}</strong>
                            <p>{timestampLabel(item.changed_at)}</p>
                          </div>
                        );
                      })}
                  </div>
                )}
              </section>
            )}



            {studentSection === 'frro-dates' && (
              <section className="panel student-dashboard-card" id="student-frro-dates">
                <div className="panel-heading">
                  <div>
                    <h2>My FRRO Dates</h2>
                    <p>Enter the dates shown on your official documents.</p>
                  </div>
                  <CalendarDays size={22} />
                </div>
                <a
                  href="https://indianfrro.gov.in/efrro/sessions/user-login"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="primary-button"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    textDecoration: 'none',
                    backgroundColor: '#228B22',
                    color: '#FFFFFF',
                    border: '1px solid #228B22',
                  }}
                >
                  Open Official FRRO Portal
                  <ExternalLink size={16} />
                </a>

                {!editingDates && (
                  <button
                    type="button"
                    className="secondary-button"
                    style={{
                      backgroundColor: '#C0392B',
                      color: '#FFFFFF',
                      borderColor: '#C0392B',
                    }}
                    onClick={() => setEditingDates(true)}
                  >
                    Update FRRO
                  </button>
                )}

                {editingDates ? (
                  <form className="message-form" onSubmit={saveDates}>
                    <label>
                      Student name
                      <input
                        value={studentDetails.full_name}
                        onChange={e =>
                          setStudentDetails(prev => ({
                            ...prev,
                            full_name: e.target.value
                          }))
                        }
                        required
                        placeholder="Full name"
                      />
                    </label>

                    <label>
                      Roll number
                      <input
                        value={studentDetails.roll_no}
                        onChange={e =>
                          setStudentDetails(prev => ({
                            ...prev,
                            roll_no: e.target.value
                          }))
                        }
                        required
                        placeholder="University roll number"
                      />
                    </label>

                    <label>
                      Course
                      <input
                        value={studentDetails.course}
                        onChange={e =>
                          setStudentDetails(prev => ({
                            ...prev,
                            course: e.target.value
                          }))
                        }
                        required
                        placeholder="e.g. B.Tech Computer Science"
                      />
                    </label>

                    <label>
                      Country
                      <input
                        value={studentDetails.country}
                        onChange={e =>
                          setStudentDetails(prev => ({
                            ...prev,
                            country: e.target.value
                          }))
                        }
                        required
                        placeholder="Country of citizenship"
                      />
                    </label>

                    <label>
                      FRRO issue date
                      <input
                        type="date"
                        value={record.frro_issue_date || ''}
                        onChange={e =>
                          setRecord(prev => ({
                            ...prev,
                            frro_issue_date: e.target.value
                          }))
                        }
                        required
                      />
                    </label>

                    <label>
                      FRRO expiry date
                      <input
                        type="date"
                        value={record.next_expiry_date || ''}
                        onChange={e =>
                          setRecord(prev => ({
                            ...prev,
                            next_expiry_date: e.target.value
                          }))
                        }
                        required
                      />
                    </label>

                    <div className="form-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setEditingDates(false);
                          loadProfileAndData();
                        }}
                      >
                        Cancel
                      </button>

                      <button
                        type="submit"
                        className="primary-button"
                        disabled={saving}
                      >
                        {saving ? 'Saving…' : 'Save details'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p>
                    {record.next_expiry_date
                      ? `Your current expiry date is ${dateLabel(record.next_expiry_date)}.`
                      : 'You have not entered your FRRO dates yet.'}
                  </p>
                )}
              </section>
            )}
            {/* Email Support */}
            {studentSection === 'support' && (
              <section className="panel" id="student-support">
                <div className="panel-heading">
                  <div>
                    <h2>Need help?</h2>
                    <p>Contact the MRU FRRO Tracker support team.</p>
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '12px',
                    alignItems: 'center',
                  }}
                >
                  <a
                    href="mailto:mrufrrotracker@gmail.com?subject=MRU%20FRRO%20Tracker%20Support"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      backgroundColor: '#123a63',
                      color: '#ffffff',
                      padding: '12px 20px',
                      borderRadius: '8px',
                      fontWeight: 700,
                      textDecoration: 'none',
                    }}
                  >
                    <Mail size={18} />
                    Open Email App
                  </a>

                  <a
                    href="https://mail.google.com/mail/?view=cm&fs=1&to=mrufrrotracker%40gmail.com&su=MRU%20FRRO%20Tracker%20Support"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      backgroundColor: '#ffffff',
                      color: '#123a63',
                      padding: '12px 20px',
                      borderRadius: '8px',
                      fontWeight: 700,
                      textDecoration: 'none',
                      border: '1px solid #123a63',
                    }}
                  >
                    <ExternalLink size={18} />
                    Open Gmail
                  </a>

                  <button
                    type="button"
                    className="secondary-button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          'mrufrrotracker@gmail.com'
                        );
                        flash('Support email address copied.');
                      } catch {
                        flash(
                          'Please copy this address manually: mrufrrotracker@gmail.com',
                          'error'
                        );
                      }
                    }}
                  >
                    Copy Support Email
                  </button>
                </div>

                <p className="muted" style={{ marginTop: '12px' }}>
                  Support email: mrufrrotracker@gmail.com
                </p>
              </section>
            )}
            {/* Student notifications */}
            {studentSection === 'messages' && (
              <section className="panel" id="student-messages">
                <div className="panel-heading">
                  <div>
                    <h2>Messages and announcements</h2>
                    <p>
                      Updates from your student services administrator.
                    </p>
                  </div>

                  <div className="message-icon">
                    <Bell size={20} />
                  </div>
                </div>

                {notifications.length > 0 ? (
                  <div className="notification-list">
                    {notifications.map(notification => (
                      <article
                        className="notification-item"
                        key={notification.id}
                      >
                        <div>
                          <h3>{notification.title}</h3>
                          <p>{notification.body}</p>
                          <span>
                            {notification.created_at
                              ? new Date(
                                notification.created_at
                              ).toLocaleString('en-IN')
                              : 'Date unavailable'}
                          </span>
                        </div>

                        {!notification.read_at && (
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => markRead(notification.id)}
                          >
                            Mark as read
                          </button>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="table-empty">No messages yet.</p>
                )}
              </section>
            )}

            <footer className="page-footer">
              <strong>MRU FRRO Tracker</strong>
              <span>•</span>
              Keep your dates accurate and follow official FRRO guidance.

              <div className="app-signature">
                <p>
                  App developed by{' '}
                  <strong>Mr Blessed Chirovamayi</strong>
                </p>
                <p>Undergraduate Mechanical Engineer</p>
                <p>Manav Rachna University</p>
                <p>24/10/2026 @ 1500 hrs</p>
              </div>
            </footer>
          </>
        )}
      </main>
    </div >
  );
}
