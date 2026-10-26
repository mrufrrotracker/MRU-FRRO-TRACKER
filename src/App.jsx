
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Activity, AlertCircle, ArrowDownRight, ArrowUpRight, Bell, CalendarDays,
  CheckCircle2, ChevronRight, Clock3, ExternalLink, FileText, History,
  LogOut, Mail, MessageSquareText, RefreshCw, Search, Send, ShieldCheck,
  Upload, Users, XCircle
} from 'lucide-react';

import { supabase, supabaseConfigured } from './supabase';
import { Capacitor } from '@capacitor/core';
import { FirebaseMessaging } from '@capacitor-firebase/messaging';


const REMINDER_DAYS = [60, 45, 30, 21, 14, 10, 7, 3, 2, 1];
const todayISO = () => new Date().toISOString().slice(0, 10);
const dayDiff = (date) => date ? Math.ceil((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86400000) : null;
const dateLabel = (date) => date ? new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not set';


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
    frro.renewal_status === 'received' &&
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
      label: 'Application in progress',
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

  const [adminDocuments, setAdminDocuments] = useState([]);
  const [loadingAdminDocuments, setLoadingAdminDocuments] = useState(false);

  const [notifications, setNotifications] = useState([]);
  const [mode, setMode] = useState('login');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingDates, setEditingDates] = useState(false);
  const [notice, setNotice] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedStudents, setSelectedStudents] = useState([]);
  const [messageTitle, setMessageTitle] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState('renewals');

  const flash = (text, type = 'success') => setNotice({ text, type });

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data, error }) => {
      if (error) flash(error.message, 'error');
      setSession(data?.session ?? null);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, next) => setSession(next)
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
        'id, storage_path, original_file_name, content_type, file_size, uploaded_at'
      )
      .eq('user_id', session.user.id)
      .order('uploaded_at', { ascending: false });

    if (error) {
      flash(`Could not load FRRO documents: ${error.message}`, 'error');
      return;
    }

    setFrroDocuments(data ?? []);
  }, [session?.user?.id]);

  const handleDocumentUpload = async (event) => {
    event.preventDefault();

    if (!selectedDocument) {
      flash('Please select your new FRRO document.', 'error');
      return;
    }

    const file = selectedDocument;
    const allowedTypes = [
      'application/pdf',
      'image/jpeg',
      'image/png',
    ];

    if (!allowedTypes.includes(file.type)) {
      flash('Please upload a PDF, JPG, or PNG file.', 'error');
      return;
    }

    if (file.size > 400 * 1024) {
      flash('The file must be 400 KB or smaller.', 'error');
      return;
    }

    setUploadingDocument(true);

    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath =
        `${session.user.id}/${Date.now()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from('FRRO Document')
        .upload(storagePath, file, {
          contentType: file.type,
          upsert: false,
        });

      if (uploadError) throw uploadError;

      const { error: metadataError } = await supabase
        .from('frro_documents')
        .insert({
          user_id: session.user.id,
          storage_path: storagePath,
          original_file_name: file.name,
          content_type: file.type,
          file_size: file.size,
        });

      if (metadataError) {
        throw new Error(
          `The file uploaded, but its record could not be saved: ${metadataError.message}`
        );
      }

      await loadFrroDocuments();
      setSelectedDocument(null);

      const input = document.getElementById('frro-document-file');
      if (input) input.value = '';

      flash('FRRO document uploaded successfully.');
    } catch (error) {
      console.error('FRRO document upload failed:', error);
      flash(error.message || 'Could not upload the FRRO document.', 'error');
    } finally {
      setUploadingDocument(false);
    }
  };



  useEffect(() => { loadProfileAndData(); }, [loadProfileAndData]);

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
          'id, user_id, storage_path, original_file_name, content_type, file_size, uploaded_at'
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
      return flash('Only verified administrators can open these documents.', 'error');
    }

    try {
      const { data, error } = await supabase.storage
        .from('FRRO Document')
        .createSignedUrl(doc.storage_path, 60);

      if (error) throw error;
      if (!data?.signedUrl) {
        throw new Error('Could not create a secure document link.');
      }

      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      flash(`Could not open document: ${error.message}`, 'error');
    }
  }

  async function confirmNewFrroReceived(student) {
    if (!supabase || !session?.user || !isAdmin) {
      return flash('Only a verified administrator can confirm receipt.', 'error');
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

      flash('New FRRO receipt confirmed. The status will show for 7 days.');

      await loadStudents();
      await loadAdminDocuments();
    } catch (e) {
      flash(e.message || 'Could not confirm the new FRRO.', 'error');
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
          'Registration submitted. Check your email if confirmation is enabled.'
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

  async function markApplicationInProgress() {
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

      setRecord(prev => ({
        ...prev,
        renewal_status: 'in_progress',
        application_applied_at: submittedAt
      }));

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

    try {
      const recipients = students
        .filter(s => selectedStudents.includes(s.user_id))
        .map(s => ({
          user_id: s.user_id,
          title: messageTitle.trim(),
          body: messageBody.trim()
        }));

      if (!recipients.length) {
        throw new Error('No selected student accounts were found.');
      }


      const { error } = await supabase
        .from('in_app_notifications')
        .insert(recipients);

      if (error) throw error;

      // Send a push notification to each selected student.
      const pushResults = await Promise.all(
        recipients.map(async (recipient) => {
          const { data, error } = await supabase.functions.invoke(
            'send-push',
            {
              body: {
                user_id: recipient.user_id,
                title: recipient.title,
                message: recipient.body,
              },
            }
          );

          if (error) {
            return { user_id: recipient.user_id, success: false };
          }

          if (data?.error) {
            return { user_id: recipient.user_id, success: false };
          }

          return {
            user_id: recipient.user_id,
            success: true,
            sent: data?.sent ?? 0,
          };
        })
      );


      const pushSent = pushResults.filter(
        (result) => result.success && result.sent > 0
      ).length;

      const pushFailed = pushResults.filter(
        (result) => !result.success
      ).length;

      const noDevice = pushResults.filter(
        (result) => result.success && result.sent === 0
      ).length;

      console.log('Push notification results:', {
        students: recipients.length,
        pushSent,
        pushFailed,
        noDevice,
        results: pushResults,
      });

      const pushNotSent = recipients.length - pushSent;

      if (pushNotSent === 0) {
        flash(
          `Announcement saved.Push accepted by Firebase for ${pushSent} student(s).`
        );
      } else {
        flash(
          `Announcement saved for ${recipients.length} student(s).Push accepted for ${pushSent}; not confirmed for ${pushNotSent}.`,
          'error'
        );
      }

      setMessageTitle('');
      setMessageBody('');
      setSelectedStudents([]);
    } catch (e) {
      flash(e.message || 'Could not send announcement.', 'error');
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

  if (!session) return <div className="auth-layout"><div className="auth-intro"><div className="brand"><div className="brand-icon">MRU</div><div><strong>MRU FRRO Tracker</strong><span>International student services</span></div></div><div className="intro-copy"><div className="eyebrow">RENEWAL MANAGEMENT, MADE SIMPLE</div><h1>Know your dates.<br /><em>Stay prepared.</em></h1><p>A calmer way to track FRRO renewals, receive timely reminders, and keep important dates in one place.</p><div className="intro-points"><span><CheckCircle2 size={17} /> Two essential dates</span><span><Bell size={17} /> Ten reminder milestones</span><span><ShieldCheck size={17} /> Protected student records</span></div></div><div className="intro-footer">MRU · Student support workspace</div></div><div className="auth-panel"><form className="auth-card" onSubmit={handleAuth}><div className="auth-card-head"><span className="eyebrow">{mode === 'login' ? 'WELCOME BACK' : 'GET STARTED'}</span><h2>{mode === 'login' ? 'Sign in to your account' : 'Create a student account'}</h2><p>{mode === 'login' ? 'Access your renewal details and reminders.' : 'Register to save your FRRO renewal dates.'}</p></div>
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
    <label>Email address<input name="email" type="email" autoComplete="email" required placeholder="you@example.com" /></label>
    <label>
      Password
      <div className="password-input-wrap">
        <input
          name="password"
          type={showPassword ? 'text' : 'password'}
          minLength="8"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          required
          placeholder="At least 8 characters"
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setShowPassword((current) => !current)}
          aria-label={showPassword ? 'Hide password' : 'Show password'}
        >
          {showPassword ? 'Hide' : 'Show'}
        </button>
      </div>
    </label>
    <button className="primary-button" disabled={saving}>{saving ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}<ChevronRight size={18} /></button><p className="switch-auth">{mode === 'login' ? 'New student?' : 'Already registered?'} <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setNotice(null); }}>{mode === 'login' ? 'Create an account' : 'Sign in instead'}</button></p><Notice notice={notice} clear={() => setNotice(null)} /></form><div className="auth-footnote">Your FRRO details should be handled only in an approved, access-controlled deployment.</div></div></div>;

  const isAdmin =
    profile?.role === 'admin' &&
    profile?.verification_status === 'verified';

  const myDays = dayDiff(record.next_expiry_date);

  return (
    <div className="app-frame">
      <aside className="sidebar">
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
              className={`nav-item ${tab === 'renewals' ? 'active' : ''}`}
              onClick={() => setTab('renewals')}
            >
              <Activity size={18} />
              Renewal overview
            </button>

            <button
              className={`nav-item ${tab === 'history' ? 'active' : ''}`}
              onClick={() => setTab('history')}
            >
              <History size={18} />
              Renewal history
            </button>

            <button
              className={`nav-item ${tab === 'documents' ? 'active' : ''}`}
              onClick={() => setTab('documents')}
            >
              <FileText size={18} />
              FRRO Documents
            </button>

            <button
              className={`nav-item ${tab === 'messages' ? 'active' : ''}`}
              onClick={() => setTab('messages')}
            >
              <MessageSquareText size={18} />
              Push messages
            </button>
          </>
        ) : (
          <div className="nav-item active">
            <CalendarDays size={18} />
            My FRRO dates
          </div>
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
              <span>{isAdmin ? 'Administrator' : 'Student account'}</span>
            </div>
          </div>

          <button className="nav-item signout" onClick={signOut}>
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
                      Application in progress
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
                        const status = renewalStatusFor(s.frro);

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

                          <td>{doc.original_file_name}</td>

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

                              {renewalStatusFor(doc.frro).key !== 'received' && (
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
                    <h2>Push messages</h2>
                    <p>
                      Send an in-app announcement to the students you selected.
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
            <section className="student-welcome">
              <div className="panel-heading">
                <div>
                  <h2>My FRRO dates</h2>
                  <p>
                    Keep your renewal and expiry information up to date.
                  </p>
                </div>
              </div>

              <div className="message-icon">
                <CalendarDays size={20} />
              </div>


              <div className="student-dashboard-grid">
                {/* Card 1: Next expiry */}
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

                {/* Card 2: Upload FRRO document */}
                <div className="panel student-dashboard-card">
                  <div className="panel-heading">
                    <div>
                      <h2>Upload new FRRO document</h2>
                      <p>Upload your renewed FRRO document for your records.</p>
                    </div>
                    <Upload size={22} />
                  </div>

                  <form onSubmit={handleDocumentUpload}>
                    <label htmlFor="frro-document-file">
                      Select document (PDF, JPG, or PNG; maximum 400 KB)
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

                  {frroDocuments.length > 0 && (
                    <div className="frro-document-list">
                      <h3>Uploaded documents</h3>

                      {frroDocuments.map(file => (
                        <div className="frro-document-item" key={file.id}>
                          <FileText size={18} />
                          <span>{file.original_file_name}</span>
                          <small>
                            {file.uploaded_at
                              ? new Date(file.uploaded_at).toLocaleDateString('en-IN')
                              : 'Date unavailable'}
                          </small>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Card 3: Renewal application */}
                <div className="panel student-dashboard-card">
                  <div className="panel-heading">
                    <div>
                      <h2>FRRO renewal application</h2>
                      <p>
                        Update your status when you submit your renewal application.
                      </p>
                    </div>
                  </div>


                  <p>
                    <strong>Status: </strong>
                    {renewalStatusFor(record).label}
                  </p>

                  {record.renewal_status !== 'in_progress' &&
                    renewalStatusFor(record).key !== 'received' && (
                      <button
                        type="button"
                        className="primary-button"
                        onClick={markApplicationInProgress}
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
                      Application in progress. When you receive your new FRRO,
                      upload the renewed document and update the issue and expiry
                      dates below.
                    </p>
                  )}
                </div>

                {/* Card 4: Update dates and official portal */}
                <div className="panel student-dashboard-card">
                  <div className="panel-heading">
                    <div>
                      <h2>Update FRRO dates</h2>
                      <p>Enter the dates shown on your official documents.</p>
                    </div>
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
                      textDecoration: 'none'
                    }}
                  >
                    Open Official FRRO Portal
                    <ExternalLink size={16} />
                  </a>

                  {!editingDates && (
                    <button
                      type="button"
                      className="secondary-button"
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
                </div>
              </div>
            </section>

            {/* Email Support */}
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Need help?</h2>
                  <p>Contact the MRU FRRO Tracker support team.</p>
                </div>
              </div>

              <a
                href="mailto:mrufrrotracker@gmail.com?subject=MRU%20FRRO%20Tracker%20Support"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  backgroundColor: '#ff0000',
                  color: '#ffffff',
                  padding: '12px 20px',
                  borderRadius: '8px',
                  fontWeight: 700,
                  textDecoration: 'none',
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                <Mail size={18} />
                Email Support
              </a>
            </section>

            {/* Student notifications */}
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Messages and announcements</h2>
                  <p>Updates from your student services administrator.</p>
                </div>
                <div className="message-icon">
                  <Bell size={20} />
                </div>
              </div>

              {notifications.length ? (
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
                            ? new Date(notification.created_at).toLocaleString('en-IN')
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
          </>
        )}

        <footer className="page-footer">
          <strong>MRU FRRO Tracker</strong>
          <span>•</span>
          Keep your dates accurate and follow official FRRO guidance.

          <div className="app-signature">
            <p>
              App developed by <strong>Mr Blessed Chirovamayi</strong>
            </p>
            <p>Undergraduate Mechanical Engineer</p>
            <p>Manav Rachna University</p>
            <p>24/10/2026 @ 1500 hrs</p>
          </div>
        </footer>
      </main>
    </div >
  );
}
